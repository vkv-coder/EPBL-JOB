-- epbl.admin_jobs() (defined in 06_boards_reports.sql) was missing from the
-- live database as of 2026-11-17 - PostgREST returned "Could not find the
-- function epbl.admin_jobs without parameters in the schema cache". It feeds
-- the admin Jobs tab and the Manual Assign job picker, so both were broken.
-- No drop of it exists anywhere in 01-09, so it was removed outside of these
-- tracked migrations. Re-applying it here, unchanged from 06.

create or replace function epbl.admin_jobs()
returns jsonb language sql stable security definer set search_path = epbl as $$
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
  from per_job where done < total;
$$;

grant execute on function epbl.admin_jobs() to anon, authenticated;
