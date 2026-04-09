/**
 * TrustWork — Supabase API Library
 * ==================================
 * Every database operation your app needs, ready to import.
 * Works in React, Next.js, Vue, or plain JavaScript.
 *
 * Install: npm install @supabase/supabase-js
 *
 * .env file:
 *   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
 *   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key  ← server-side only!
 */

import { createClient } from '@supabase/supabase-js';

// ─── CLIENT SETUP ──────────────────────────────────────────────────────────

// Public client — use in frontend (browser)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Admin client — use ONLY in backend/server (never expose this key!)
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════

/**
 * Register a new user (worker or hirer)
 * Called from your onboarding screen after role selection
 */
export async function signUp({ email, password, fullName, phone, role }) {
  // Step 1: Create auth user
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName, role },  // stored in auth.users metadata
    },
  });
  if (authError) throw authError;

  // Step 2: Create public profile (triggers after email confirmation)
  const { error: profileError } = await supabase.from('profiles').insert({
    id:        authData.user.id,
    full_name: fullName,
    email,
    phone,
    role,
  });
  if (profileError) throw profileError;

  // Step 3: Create role-specific profile
  if (role === 'worker') {
    await supabase.from('worker_profiles').insert({ user_id: authData.user.id });
  } else if (role === 'hirer') {
    await supabase.from('hirer_profiles').insert({
      user_id: authData.user.id,
      business_name: fullName,  // updated later in onboarding
    });
  }

  return authData;
}

export async function signIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from('profiles').select('*').eq('id', user.id).single();
  return { ...user, profile };
}

// ═══════════════════════════════════════════════════════════════════
// JOBS
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch all active public jobs
 * Supports filtering, searching, and pagination — handles thousands of jobs fast
 */
export async function getJobs({
  category   = null,
  currency   = null,
  search     = null,
  minBudget  = null,
  maxBudget  = null,
  page       = 1,
  limit      = 20,
} = {}) {
  let query = supabase
    .from('jobs')
    .select(`
      *,
      hirer:profiles!jobs_hirer_id_fkey(id, full_name, avatar_url, average_rating),
      hirer_profile:hirer_profiles(business_name, verified_hirer)
    `)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (category)  query = query.eq('category', category);
  if (currency)  query = query.eq('currency', currency);
  if (minBudget) query = query.gte('budget', minBudget);
  if (maxBudget) query = query.lte('budget', maxBudget);
  if (search)    query = query.textSearch('title', search, { type: 'websearch' });

  const { data, error, count } = await query;
  if (error) throw error;
  return { jobs: data, total: count, page, limit };
}

/**
 * Get a single job with full details
 */
export async function getJob(jobId) {
  const { data, error } = await supabase
    .from('jobs')
    .select(`
      *,
      hirer:profiles!jobs_hirer_id_fkey(id, full_name, avatar_url, average_rating),
      hirer_profile:hirer_profiles(business_name, verified_hirer, industry),
      assigned_worker:profiles!jobs_assigned_worker_id_fkey(id, full_name, avatar_url, average_rating)
    `)
    .eq('id', jobId)
    .single();

  // Increment view count (fire and forget)
  supabase.from('jobs').update({ views: data?.views + 1 }).eq('id', jobId);

  if (error) throw error;
  return data;
}

/**
 * Post a new job (hirer only)
 * Job starts as 'draft' until escrow is funded
 */
export async function createJob({
  hirerId, title, description, category,
  skillsRequired, budget, currency, duration,
}) {
  const { data: settings } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', [`fee_percent_${currency.toLowerCase()}`]);

  const feePercent  = parseFloat(settings?.[0]?.value || 10);
  const platformFee = Math.round(budget * (feePercent / 100) * 100) / 100;
  const workerPayout = budget - platformFee;

  const { data, error } = await supabase.from('jobs').insert({
    hirer_id:         hirerId,
    title,
    description,
    category,
    skills_required:  skillsRequired,
    budget,
    currency,
    duration,
    platform_fee:     platformFee,
    platform_fee_pct: feePercent,
    worker_payout:    workerPayout,
    status:           'draft',
  }).select().single();

  if (error) throw error;
  return data;
}

/**
 * Activate job after escrow is funded (called from Paystack webhook)
 */
export async function activateJob(jobId, paystackReference) {
  const { data, error } = await supabaseAdmin.from('jobs').update({
    status:           'active',
    escrow_funded:    true,
    escrow_reference: paystackReference,
    escrow_funded_at: new Date().toISOString(),
  }).eq('id', jobId).select().single();

  if (error) throw error;

  // Notify relevant workers (e.g. those with matching skills)
  await createNotification({
    userId:  data.hirer_id,
    type:    'job_activated',
    title:   'Your job is live!',
    message: `"${data.title}" is now accepting applicants.`,
    data:    { job_id: jobId },
  });

  return data;
}

// ═══════════════════════════════════════════════════════════════════
// APPLICATIONS
// ═══════════════════════════════════════════════════════════════════

export async function applyToJob({ jobId, workerId, coverLetter, proposedRate, currency, portfolioLink }) {
  const { data, error } = await supabase.from('applications').insert({
    job_id:        jobId,
    worker_id:     workerId,
    cover_letter:  coverLetter,
    proposed_rate: proposedRate,
    currency,
    portfolio_link: portfolioLink,
  }).select().single();

  if (error) throw error;

  // Notify hirer
  const job = await getJob(jobId);
  await createNotification({
    userId:  job.hirer_id,
    type:    'new_application',
    title:   'New application received',
    message: `Someone applied to "${job.title}".`,
    data:    { job_id: jobId, application_id: data.id },
  });

  return data;
}

export async function getApplicationsForJob(jobId) {
  const { data, error } = await supabase
    .from('applications')
    .select(`
      *,
      worker:profiles!applications_worker_id_fkey(
        id, full_name, avatar_url, average_rating, total_reviews
      ),
      worker_profile:worker_profiles(skills, jobs_completed, success_rate, experience_level)
    `)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function acceptApplication(applicationId, jobId, workerId) {
  // Set application to accepted
  await supabase.from('applications')
    .update({ status: 'accepted' }).eq('id', applicationId);

  // Reject all other applications for this job
  await supabase.from('applications')
    .update({ status: 'rejected' })
    .eq('job_id', jobId)
    .neq('id', applicationId);

  // Assign worker to job
  const { data, error } = await supabase.from('jobs')
    .update({ assigned_worker_id: workerId, status: 'in_progress' })
    .eq('id', jobId).select().single();

  if (error) throw error;

  // Notify worker
  await createNotification({
    userId:  workerId,
    type:    'application_accepted',
    title:   'Application accepted!',
    message: `Your application for "${data.title}" was accepted. Start working!`,
    data:    { job_id: jobId },
  });

  return data;
}

// ═══════════════════════════════════════════════════════════════════
// SUBMISSIONS & PAYMENTS
// ═══════════════════════════════════════════════════════════════════

export async function submitWork({ jobId, workerId, message, fileUrls, externalLinks }) {
  // Get latest version number
  const { count } = await supabase.from('submissions')
    .select('*', { count: 'exact' }).eq('job_id', jobId);

  const { data, error } = await supabase.from('submissions').insert({
    job_id:         jobId,
    worker_id:      workerId,
    message,
    file_urls:      fileUrls,
    external_links: externalLinks,
    version:        (count || 0) + 1,
  }).select().single();

  if (error) throw error;

  // Update job status
  await supabase.from('jobs').update({ status: 'submitted' }).eq('id', jobId);

  // Notify hirer
  const job = await getJob(jobId);
  await createNotification({
    userId:  job.hirer_id,
    type:    'work_submitted',
    title:   'Work submitted for review',
    message: `The worker has submitted deliverables for "${job.title}". Review and approve to release payment.`,
    data:    { job_id: jobId, submission_id: data.id },
  });

  return data;
}

/**
 * Hirer approves work — triggers payment release
 * The actual Paystack transfer is called from your backend after this
 */
export async function approveWork(submissionId, jobId) {
  await supabase.from('submissions')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', submissionId);

  const { data: job, error } = await supabase.from('jobs')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', jobId).select().single();

  if (error) throw error;

  // Update worker's completed jobs count
  await supabase.from('worker_profiles')
    .update({ jobs_completed: supabase.rpc('increment', { x: 1 }) })
    .eq('user_id', job.assigned_worker_id);

  await createNotification({
    userId:  job.assigned_worker_id,
    type:    'payment_released',
    title:   '💸 Payment is on its way!',
    message: `Your payment for "${job.title}" has been approved and is being transferred to your account.`,
    data:    { job_id: jobId, amount: job.worker_payout, currency: job.currency },
  });

  return job;
}

// ═══════════════════════════════════════════════════════════════════
// DISPUTES
// ═══════════════════════════════════════════════════════════════════

export async function raiseDispute({ jobId, raisedBy, against, reason, evidenceUrls }) {
  const { data, error } = await supabase.from('disputes').insert({
    job_id:        jobId,
    raised_by:     raisedBy,
    against,
    reason,
    evidence_urls: evidenceUrls,
  }).select().single();

  if (error) throw error;

  // Freeze the job
  await supabase.from('jobs').update({ status: 'disputed' }).eq('id', jobId);

  // Freeze escrow
  await supabase.from('escrow_transactions')
    .update({ status: 'disputed' }).eq('job_id', jobId);

  // Alert admin (use service role so admin gets notified regardless of RLS)
  await supabaseAdmin.from('notifications').insert({
    user_id: against,
    type:    'dispute_raised',
    title:   'A dispute has been raised',
    message: 'TrustWork is reviewing the case. Funds are frozen until resolved.',
    data:    { job_id: jobId, dispute_id: data.id },
  });

  return data;
}

// ═══════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════

export async function leaveReview({ jobId, reviewerId, revieweeId, rating, comment }) {
  const { data, error } = await supabase.from('reviews').insert({
    job_id:      jobId,
    reviewer_id: reviewerId,
    reviewee_id: revieweeId,
    rating,
    comment,
    is_verified: true,
  }).select().single();

  if (error) throw error;
  return data;
}

export async function getWorkerReviews(workerId) {
  const { data, error } = await supabase
    .from('reviews')
    .select(`*, reviewer:profiles!reviews_reviewer_id_fkey(full_name, avatar_url)`)
    .eq('reviewee_id', workerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATIONS (Realtime)
// ═══════════════════════════════════════════════════════════════════

export async function createNotification({ userId, type, title, message, data = {} }) {
  const { error } = await supabaseAdmin.from('notifications').insert({
    user_id: userId, type, title, message, data,
  });
  if (error) console.error('Notification error:', error);
}

export async function getNotifications(userId, limit = 20) {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function markNotificationsRead(userId) {
  await supabase.from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId).eq('is_read', false);
}

/**
 * Subscribe to real-time notifications for a user.
 * Call this once when user logs in — updates arrive instantly.
 *
 * Usage:
 *   const unsub = subscribeToNotifications(userId, (notif) => {
 *     showToast(notif.title);
 *   });
 *   // Call unsub() when user logs out or component unmounts
 */
export function subscribeToNotifications(userId, onNew) {
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'notifications',
      filter: `user_id=eq.${userId}`,
    }, (payload) => onNew(payload.new))
    .subscribe();

  return () => supabase.removeChannel(channel);
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN — PLATFORM EARNINGS
// ═══════════════════════════════════════════════════════════════════

export async function getPlatformStats() {
  const [jobsRes, escrowRes, usersRes, disputeRes] = await Promise.all([
    supabaseAdmin.from('jobs').select('status, currency, budget, platform_fee, worker_payout', { count: 'exact' }),
    supabaseAdmin.from('escrow_transactions').select('status, currency, gross_amount, platform_fee'),
    supabaseAdmin.from('profiles').select('role, created_at', { count: 'exact' }),
    supabaseAdmin.from('disputes').select('status', { count: 'exact' }),
  ]);

  const completed = escrowRes.data?.filter(e => e.status === 'released') || [];
  const ngnRevenue = completed.filter(e => e.currency === 'NGN').reduce((s, e) => s + e.platform_fee, 0);
  const usdRevenue = completed.filter(e => e.currency === 'USD').reduce((s, e) => s + e.platform_fee, 0);

  return {
    totalUsers:      usersRes.count || 0,
    totalJobs:       jobsRes.count  || 0,
    completedJobs:   completed.length,
    openDisputes:    disputeRes.data?.filter(d => d.status === 'open').length || 0,
    revenue: {
      NGN: `₦${ngnRevenue.toLocaleString()}`,
      USD: `$${usdRevenue.toLocaleString()}`,
    },
    activeEscrow: escrowRes.data?.filter(e => e.status === 'funded').length || 0,
  };
}

export async function getPlatformSettings() {
  const { data } = await supabaseAdmin.from('platform_settings').select('*');
  return Object.fromEntries(data.map(s => [s.key, s.value]));
}

export async function updatePlatformSetting(key, value, adminId) {
  await supabaseAdmin.from('platform_settings')
    .update({ value, updated_at: new Date().toISOString(), updated_by: adminId })
    .eq('key', key);
}
