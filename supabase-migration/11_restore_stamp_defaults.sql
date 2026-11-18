-- The 2026-11-12 admin-token lockdown (09_admin_session_lockdown.sql)
-- rewrote stamp_start/stamp_stop and dropped the `default null` on
-- p_worker_id that 08_fix_missing_defaults.sql had deliberately added
-- back in September - the admin UI never sends worker_id (that branch
-- was never wired into the UI), so every admin Start/Stop call started
-- failing with PGRST202 "Could not find the function epbl.stamp_start".
-- Restoring the defaults, same signature otherwise as 09's version.

create or replace function epbl.stamp_start(p_job_no text, p_seq int, p_worker_id text default null, p_admin_token text default null)
returns jsonb language plpgsql security definer set search_path = epbl as $$
declare v_sched record; v_now timestamptz := now();
begin
  if epbl._require_admin(p_admin_token) is null then
    return jsonb_build_object('success', false, 'error', 'Not authorized. Please log in again.');
  end if;
  select status, act_start into v_sched from epbl.schedule where job_no = p_job_no and seq = p_seq;
  if not found then return jsonb_build_object('success', false, 'error', 'Process not found'); end if;
  if v_sched.status = 'In Progress' and v_sched.act_start is not null then
    return jsonb_build_object('success', false, 'error', 'Already started');
  end if;
  update epbl.schedule set act_start = v_now, status = 'In Progress'
  where job_no = p_job_no and seq = p_seq;
  return jsonb_build_object('success', true, 'actStart', to_char(v_now, 'DD/MM/YYYY HH24:MI'));
end $$;

create or replace function epbl.stamp_stop(p_job_no text, p_seq int, p_worker_id text default null, p_admin_token text default null)
returns jsonb language plpgsql security definer set search_path = epbl as $$
declare v_admin_email text;
begin
  v_admin_email := epbl._require_admin(p_admin_token);
  if v_admin_email is null then
    return jsonb_build_object('success', false, 'error', 'Not authorized. Please log in again.');
  end if;
  return epbl._close_seq(p_job_no, p_seq, null, null, v_admin_email);
end $$;
