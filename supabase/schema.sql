-- ============================================================================
-- hd-project07 — Field-Insight (현장 이슈 접수 → 전문가 판단 → 회신 → Knowledge)
-- Supabase(Postgres) 운영 스키마 + RLS · 재실행 안전
--
--  이 스키마는 **수강생 본인의 Supabase 프로젝트**에 올리는 것을 전제로 합니다.
--  프로젝트가 본인 것이라 테이블 이름에 접두사를 붙이지 않았습니다.
--  (여러 앱을 한 프로젝트에 몰아 쓸 계획이면 이름 충돌을 먼저 확인하세요.)
--
--  이 시스템의 규칙 두 가지를 DB 가 직접 지킵니다.
--   ① 상태는 정해진 순서로만 넘어간다 (접수 → 검토 → 회신 → 해결확인)
--   ② **고객이 해결을 확인한 사례만** Knowledge 로 넘어간다
--  화면에서만 막으면 다른 경로로 들어온 값이 그대로 통과합니다.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

create table if not exists public.app_user (
  user_id    uuid primary key,
  name       text not null,
  email      text,
  -- 한 사람이 접수자이면서 전문가일 수 있다 (기획서의 user.roles[] 그대로)
  roles      text[] not null default array['reporter']::text[],
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint app_user_roles_valid
    check (roles <@ array['reporter','expert','approver','admin']::text[]
           and coalesce(array_length(roles, 1), 0) > 0)
);

-- 이슈 — 상태 기계의 주체
create table if not exists public.issue (
  id            bigint generated always as identity primary key,
  code          text unique,                      -- 'ISSUE #1024'
  domain        text not null default '정비',
  title         text not null,
  raw_text      text not null,                    -- 현장 사용자가 쓴 원문(전문용어 없이)
  structured    jsonb not null default '{}'::jsonb, -- AI 가 정형화한 결과
  status        text not null default 'DRAFT'
                check (status in ('DRAFT','IN_REVIEW','CONCLUDED','REPLIED','RESOLVED','CLOSED')),
  reporter_id   uuid,
  expert_id     uuid,
  equipment     text,
  site          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  -- 해결 확인이 되었으면 시각이 있어야 한다. 둘이 어긋나면 Knowledge 판정이 흔들린다.
  constraint issue_resolved_consistency
    check ((status in ('RESOLVED','CLOSED')) = (resolved_at is not null))
);
create index if not exists issue_status_idx on public.issue (status, created_at desc);

-- AI 가 던지는 질문 — 판단을 바꿀 질문 3개 이내
create table if not exists public.question (
  id         bigint generated always as identity primary key,
  issue_id   bigint not null references public.issue(id) on delete cascade,
  seq        int not null check (seq between 1 and 3),
  question   text not null,
  answer     text,
  asked_at   timestamptz not null default now(),
  constraint question_uniq unique (issue_id, seq)
);

-- 전문가 결론 — 확정원인·조치·근거·재발방지 4필드
create table if not exists public.conclusion (
  id            bigint generated always as identity primary key,
  issue_id      bigint not null references public.issue(id) on delete cascade,
  root_cause    text not null,
  action        text not null,
  evidence      text not null,
  prevention    text not null,
  expert_id     uuid default auth.uid(),
  concluded_at  timestamptz not null default now(),
  -- 이슈 하나에 결론 하나. 여러 개면 어느 것이 회신 근거인지 알 수 없다.
  constraint conclusion_one unique (issue_id),
  -- 4필드가 모두 채워져야 결론이다. 빈 문자열도 막는다.
  constraint conclusion_filled check (
    btrim(root_cause) <> '' and btrim(action) <> ''
    and btrim(evidence) <> '' and btrim(prevention) <> '')
);

-- 고객 회신 (고객 언어로 변환 + 승인)
create table if not exists public.reply (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references public.issue(id) on delete cascade,
  body         text not null,
  approved_by  uuid,
  approved_at  timestamptz,
  sent_at      timestamptz,
  -- 승인 없이 나갈 수 없다
  constraint reply_approved_before_sent
    check (sent_at is null or approved_at is not null),
  constraint reply_one unique (issue_id)
);

-- 고객 해결 확인
create table if not exists public.resolution (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references public.issue(id) on delete cascade,
  confirmed    boolean not null,
  comment      text,
  confirmed_at timestamptz not null default now(),
  constraint resolution_one unique (issue_id)
);

-- Knowledge — 고객이 해결을 확인한 사례만 들어온다 (트리거가 강제)
create table if not exists public.knowledge (
  id           bigint generated always as identity primary key,
  issue_id     bigint not null references public.issue(id) on delete cascade,
  title        text not null,
  symptom      text,
  root_cause   text not null,
  action       text not null,
  prevention   text,
  tags         text[] default '{}'::text[],
  created_at   timestamptz not null default now(),
  constraint knowledge_one unique (issue_id)
);
create index if not exists knowledge_tags_idx on public.knowledge using gin (tags);

create table if not exists public.attachment (
  id         bigint generated always as identity primary key,
  issue_id   bigint not null references public.issue(id) on delete cascade,
  kind       text not null check (kind in ('image','video','audio','file')),
  file_name  text not null,
  storage_path text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.log (
  id        bigint generated always as identity primary key,
  ran_at    timestamptz not null default now(),
  kind      text not null,
  issue_id  bigint,
  detail    text,
  actor     uuid default auth.uid()
);
create index if not exists log_ran_at_idx on public.log (ran_at desc);

create table if not exists public.admin (
  user_id uuid primary key, email text, created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. 함수 · 상태 기계
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.admin a where a.user_id = auth.uid())
      or exists (select 1 from public.app_user u
                  where u.user_id = auth.uid() and 'admin' = any(u.roles));
$fn$;

create or replace function public.has_role(p_role text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.app_user u
                  where u.user_id = auth.uid() and u.active and p_role = any(u.roles));
$fn$;

/**
 * 상태 전이 규칙.
 *
 * 되돌리기(회신 → 검토)는 허용한다. 실무에서 전문가가 결론을 다시 잡는 일이 있다.
 * 다만 **건너뛰기는 막는다** — 접수 상태에서 바로 해결로 갈 수 없다.
 * 화면에서만 막으면 API 를 직접 부르는 순간 뚫린다.
 */
create or replace function public.can_transition(p_from text, p_to text)
returns boolean language sql immutable set search_path = public as $fn$
  select case
    when p_from = p_to then true
    when p_from = 'DRAFT'     and p_to = 'IN_REVIEW' then true
    when p_from = 'IN_REVIEW' and p_to in ('CONCLUDED','DRAFT') then true
    when p_from = 'CONCLUDED' and p_to in ('REPLIED','IN_REVIEW') then true
    when p_from = 'REPLIED'   and p_to in ('RESOLVED','CONCLUDED') then true
    -- 재발하면 되돌린다. 고객이 한 번 확인했어도 같은 증상이 다시 나는 일이 있고,
    -- 그때 새 이슈로 다시 접수하게 하면 이력이 끊긴다.
    when p_from = 'RESOLVED'  and p_to in ('CLOSED', 'REPLIED') then true
    else false
  end;
$fn$;

create or replace function public.guard_transition()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not public.can_transition(old.status, new.status) then
      raise exception '허용되지 않는 상태 전이입니다: % → %', old.status, new.status;
    end if;
    -- CONCLUDED 로 가려면 결론 4필드가 있어야 한다
    if new.status = 'CONCLUDED'
       and not exists (select 1 from public.conclusion c where c.issue_id = new.id) then
      raise exception '결론(확정원인·조치·근거·재발방지)이 없으면 CONCLUDED 로 갈 수 없습니다.';
    end if;
    -- REPLIED 로 가려면 승인된 회신이 있어야 한다
    if new.status = 'REPLIED'
       and not exists (select 1 from public.reply r
                        where r.issue_id = new.id and r.approved_at is not null) then
      raise exception '승인된 회신이 없으면 REPLIED 로 갈 수 없습니다.';
    end if;
    if new.status in ('RESOLVED','CLOSED') and new.resolved_at is null then
      new.resolved_at := now();
    end if;
    if new.status not in ('RESOLVED','CLOSED') then
      new.resolved_at := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists issue_guard on public.issue;
create trigger issue_guard before update on public.issue
  for each row execute function public.guard_transition();

/**
 * Knowledge 축적 규칙 — 기획서의 핵심 문장.
 * "고객이 해결을 확인한 사례만 Knowledge 로 축적한다."
 */
create or replace function public.guard_knowledge()
returns trigger language plpgsql set search_path = public as $fn$
declare v_ok boolean;
begin
  select coalesce(r.confirmed, false) and i.status in ('RESOLVED','CLOSED')
    into v_ok
    from public.issue i
    left join public.resolution r on r.issue_id = i.id
   where i.id = new.issue_id;

  if not coalesce(v_ok, false) then
    raise exception '고객이 해결을 확인한 이슈만 Knowledge 로 축적할 수 있습니다 (issue_id=%)', new.issue_id;
  end if;
  return new;
end;
$fn$;

drop trigger if exists knowledge_guard on public.knowledge;
create trigger knowledge_guard before insert or update on public.knowledge
  for each row execute function public.guard_knowledge();

-- ----------------------------------------------------------------------------
-- 3. 뷰
-- ----------------------------------------------------------------------------

create or replace view public.issue_view as
select i.*,
       (select count(*) from public.question q where q.issue_id = i.id) as question_count,
       (select count(*) from public.attachment a where a.issue_id = i.id) as attachment_count,
       c.root_cause, c.action, c.evidence, c.prevention,
       rp.approved_at is not null as reply_approved,
       rs.confirmed              as customer_confirmed,
       (k.id is not null)        as in_knowledge
from public.issue i
left join public.conclusion c  on c.issue_id  = i.id
left join public.reply rp      on rp.issue_id = i.id
left join public.resolution rs on rs.issue_id = i.id
left join public.knowledge k   on k.issue_id  = i.id;

-- Knowledge 후보 — 해결 확인은 됐는데 아직 안 올린 것
create or replace view public.knowledge_candidates as
select id, code, title, root_cause, action, prevention, resolved_at
from public.issue_view
where customer_confirmed is true and in_knowledge = false;

create or replace view public.status_summary as
select status, count(*) as cnt from public.issue group by status;

-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------

alter table public.app_user       enable row level security;
alter table public.issue      enable row level security;
alter table public.question   enable row level security;
alter table public.conclusion enable row level security;
alter table public.reply      enable row level security;
alter table public.resolution enable row level security;
alter table public.knowledge  enable row level security;
alter table public.attachment enable row level security;
alter table public.log        enable row level security;
alter table public.admin      enable row level security;

-- 이슈: 로그인 사용자는 다 읽고, 접수자가 만들고, 전문가·관리자가 고친다
drop policy if exists issue_read   on public.issue;
drop policy if exists issue_write  on public.issue;
drop policy if exists issue_update on public.issue;
drop policy if exists issue_delete on public.issue;
create policy issue_read   on public.issue for select to authenticated using (true);
create policy issue_write  on public.issue for insert to authenticated
  with check (public.has_role('reporter') or public.is_admin());
create policy issue_update on public.issue for update to authenticated
  using (public.is_admin() or public.has_role('expert') or reporter_id = auth.uid())
  with check (public.is_admin() or public.has_role('expert') or reporter_id = auth.uid());
create policy issue_delete on public.issue for delete to authenticated
  using (public.is_admin());

-- 결론은 전문가만
drop policy if exists conclusion_read   on public.conclusion;
drop policy if exists conclusion_write  on public.conclusion;
drop policy if exists conclusion_update on public.conclusion;
create policy conclusion_read   on public.conclusion for select to authenticated using (true);
create policy conclusion_write  on public.conclusion for insert to authenticated
  with check (public.has_role('expert') or public.is_admin());
create policy conclusion_update on public.conclusion for update to authenticated
  using (public.has_role('expert') or public.is_admin())
  with check (public.has_role('expert') or public.is_admin());

-- 나머지 부속 표
do $rls$
declare t text;
begin
  foreach t in array array['question','reply','resolution',
                           'knowledge','attachment']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_write',  t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (true)', t || '_write', t);
    execute format('create policy %I on public.%I for update to authenticated using (true) with check (true)', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())', t || '_delete', t);
  end loop;
end;
$rls$;

drop policy if exists app_user_read   on public.app_user;
drop policy if exists app_user_write  on public.app_user;
drop policy if exists app_user_update on public.app_user;
create policy app_user_read   on public.app_user for select to authenticated using (true);
create policy app_user_write  on public.app_user for insert to authenticated with check (public.is_admin());
create policy app_user_update on public.app_user for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists log_read  on public.log;
drop policy if exists log_write on public.log;
create policy log_read  on public.log for select to authenticated using (true);
create policy log_write on public.log for insert to authenticated with check (true);

drop policy if exists admin_read on public.admin;
create policy admin_read on public.admin for select to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 5. 함수 실행 권한 (§3.7)
-- ----------------------------------------------------------------------------

revoke all on function public.is_admin()                    from public, anon;
revoke all on function public.has_role(text)                from public, anon;
revoke all on function public.can_transition(text, text)    from public, anon;
revoke all on function public.guard_transition()            from public, anon;
revoke all on function public.guard_knowledge()             from public, anon;

grant execute on function public.is_admin()                 to authenticated;
grant execute on function public.has_role(text)             to authenticated;
grant execute on function public.can_transition(text, text) to authenticated;
grant execute on function public.guard_transition()         to authenticated;
grant execute on function public.guard_knowledge()          to authenticated;

-- ----------------------------------------------------------------------------
-- 끝. 사용자 등록:
--   insert into public.app_user (user_id, name, email, roles)
--   select id, '<이름>', email, array['reporter','expert'] from auth.users where email = '<이메일>'
--   on conflict (user_id) do nothing;
-- ----------------------------------------------------------------------------

-- ===============================================================
-- 팀 공용 문서 (hd-docsync.js 용)
--
--   이 표 하나에 앱의 JSON 문서를 통째로 담아 팀원이 같은 것을 본다.
--   팀 내부 도구 — 어차피 서로 다 보는 화면 — 에만 쓴다.
--   사람마다 볼 범위가 달라야 하는 화면에는 쓸 수 없다(모두가 전부를 받게 된다).
-- ===============================================================

create table if not exists workspace (
  id         text primary key,
  doc        jsonb not null default '{}'::jsonb,
  -- 동시 편집으로 남의 작업이 조용히 사라지지 않게 하는 장치.
  -- 저장할 때 "내가 받아 온 버전"과 같은지 확인하고, 다르면 쓰지 않는다.
  version    bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table workspace enable row level security;

drop policy if exists workspace_read   on workspace;
drop policy if exists workspace_write  on workspace;
drop policy if exists workspace_update on workspace;
drop policy if exists workspace_delete on workspace;

-- 팀 내부 도구라 로그인한 사람은 읽고 쓴다.
-- 더 좁히려면 아래 정책의 using/with check 를 조직 규칙에 맞게 바꾸면 된다.
create policy workspace_read   on workspace for select to authenticated using (true);
create policy workspace_write  on workspace for insert to authenticated with check (true);
create policy workspace_update on workspace for update to authenticated using (true) with check (true);
-- DELETE 정책은 두지 않는다. 팀 자료를 화면에서 통째로 지울 수 있으면 안 된다.
