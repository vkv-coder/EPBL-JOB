-- epbl.get_all_workers() went missing from the live database, same
-- symptom as 10_restore_admin_jobs.sql's admin_jobs() - PostgREST
-- returned PGRST202 "Could not find the function epbl.get_all_workers
-- without parameters in the schema cache". Broke the Manual Assign
-- worker dropdown and the Worker Management screen. No tracked
-- migration drops it; re-applied unchanged from 02_auth.sql. Found via
-- a full sweep of all 33 RPCs the app calls, tested against the live
-- database with the exact params each call site sends - every other
-- RPC matched correctly, so this was an isolated recurrence, not a
-- wider break.

create or replace function epbl.get_all_workers()
returns jsonb language sql stable security definer set search_path = epbl as $$
  select jsonb_build_object('success', true, 'workers', coalesce(jsonb_agg(jsonb_build_object(
    'workerId', worker_id, 'name', name, 'mobile', mobile,
    'dept1', dept1, 'dept2', coalesce(dept2, ''), 'status', status
  )), '[]'::jsonb))
  from epbl.workers;
$$;

grant execute on function epbl.get_all_workers() to anon, authenticated;
