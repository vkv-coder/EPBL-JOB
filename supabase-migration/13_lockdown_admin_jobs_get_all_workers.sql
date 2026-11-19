-- 10_restore_admin_jobs.sql and 12_restore_get_all_workers.sql re-applied
-- admin_jobs() and get_all_workers() unchanged from their ORIGINAL pre-lockdown
-- bodies (06_boards_reports.sql / 02_auth.sql) to fix a vanished-function
-- break. Those originals predate 09_admin_session_lockdown.sql, so restoring
-- them unchanged also silently undid that lockdown for just these two
-- functions - anon could call get_all_workers() and pull every worker's
-- name/mobile/department with no auth check at all (found by the 2026-11-19
-- daily audit). This migration re-adds the same p_admin_token check every
-- other admin-facing RPC already has, matching toggle_worker's pattern.

create or replace function epbl.admin_jobs(p_admin_token text)
returns jsonb language plpgsql security definer set search_path = epbl as $$
declare v_admin_email text;
begin
  v_admin_email := epbl._require_admin(p_admin_token);
  if v_admin_email is null then
    return jsonb_build_object('success', false, 'error', 'Not authorized. Please log in again.');
  end if;

  return (
    with per_job as (
      select job_no, min(product_type) as product_type, min(customer) as customer,
        count(*) as total, count(*) filter (where status = 'Done') as done,
        count(*) filter (where status in ('Pending', 'Rework') and now() > plan_start) as overdue,
        count(*) filter (where status = 'Pending Inspection') as pend_insp
      from epbl.schedule where process_name <> 'INSPECTION'
      group by job_no
    )
    select jsonb_build_object('success', true, 'jobs', coalesce(jsonb_agg(jsonb_build_object(
      'jobNo', job_no, 'type', product_type, 'cust', customer, 'total', total, 'done', done,
      'overdue', overdue, 'pendInsp', pend_insp, 'progress', round(done::numeric / nullif(total, 0) * 100)
    )), '[]'::jsonb))
    from per_job where done < total
  );
end $$;

drop function if exists epbl.admin_jobs();
grant execute on function epbl.admin_jobs(text) to anon, authenticated;

create or replace function epbl.get_all_workers(p_admin_token text)
returns jsonb language plpgsql security definer set search_path = epbl as $$
declare v_admin_email text;
begin
  v_admin_email := epbl._require_admin(p_admin_token);
  if v_admin_email is null then
    return jsonb_build_object('success', false, 'error', 'Not authorized. Please log in again.');
  end if;

  return (
    select jsonb_build_object('success', true, 'workers', coalesce(jsonb_agg(jsonb_build_object(
      'workerId', worker_id, 'name', name, 'mobile', mobile,
      'dept1', dept1, 'dept2', coalesce(dept2, ''), 'status', status
    )), '[]'::jsonb))
    from epbl.workers
  );
end $$;

drop function if exists epbl.get_all_workers();
grant execute on function epbl.get_all_workers(text) to anon, authenticated;
