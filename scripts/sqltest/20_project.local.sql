-- 로컬 검증 전용 — hd-project07 (운영 실행 금지)
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin','authenticator'))
     or exists (select 1 from pg_namespace where nspname='graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다.';
  end if;
end;
$guard$;

do $t$ begin raise notice '[프로젝트] 상태 기계 · 결론 4필드 · Knowledge 축적 규칙'; end $t$;

do $t$ begin
  perform public._assert(    public.can_transition('DRAFT','IN_REVIEW'),  '접수 → 검토');
  perform public._assert(    public.can_transition('IN_REVIEW','DRAFT'),  '검토 → 접수 (되돌리기 허용)');
  perform public._assert(    public.can_transition('REPLIED','CONCLUDED'),'회신 → 결론 (다시 잡기 허용)');
  perform public._assert(not public.can_transition('DRAFT','RESOLVED'),   '접수에서 해결로 건너뛸 수 없다');
  perform public._assert(not public.can_transition('DRAFT','CLOSED'),     '접수에서 종료로 건너뛸 수 없다');
  perform public._assert(    public.can_transition('RESOLVED','REPLIED'), '해결 → 회신 (재발 시 되돌리기)');
  perform public._assert(not public.can_transition('CLOSED','DRAFT'),     '종료된 것을 되살릴 수 없다');
  perform public._assert(not public.can_transition('RESOLVED','DRAFT'),   '해결에서 접수로 건너뛸 수는 없다');
end $t$;

do $t$
declare v_id bigint; v_r boolean;
begin
  insert into public.issue (code, title, raw_text)
  values ('T-1001','시동이 안 걸립니다','아침에 키를 돌려도 반응이 없어요')
  on conflict (code) do nothing;
  select id into v_id from public.issue where code='T-1001';

  perform public._assert_eq((select status from public.issue where id=v_id), 'DRAFT', '처음은 DRAFT');

  -- 건너뛰기는 트리거가 막는다 (화면이 아니라 DB 가 막는 것이 요점)
  v_r := false;
  begin
    update public.issue set status='RESOLVED' where id=v_id;
  exception when others then v_r := true;
  end;
  perform public._assert(v_r, 'DRAFT 에서 RESOLVED 로 바로 갈 수 없다 (트리거가 막는다)');

  update public.issue set status='IN_REVIEW' where id=v_id;
  perform public._assert_eq((select status from public.issue where id=v_id), 'IN_REVIEW', 'DRAFT → IN_REVIEW');

  -- 결론이 없으면 CONCLUDED 로 못 간다
  v_r := false;
  begin
    update public.issue set status='CONCLUDED' where id=v_id;
  exception when others then v_r := true;
  end;
  perform public._assert(v_r, '결론이 없으면 CONCLUDED 로 갈 수 없다');

  -- 4필드 중 하나라도 비면 결론이 아니다
  v_r := false;
  begin
    insert into public.conclusion (issue_id, root_cause, action, evidence, prevention)
    values (v_id, '배터리 방전', '교체', '', '주기 점검');
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '근거가 비면 결론으로 저장되지 않는다');

  insert into public.conclusion (issue_id, root_cause, action, evidence, prevention)
  values (v_id, '배터리 방전', '배터리 교체', '전압 측정 10.2V', '월 1회 전압 점검');
  update public.issue set status='CONCLUDED' where id=v_id;
  perform public._assert_eq((select status from public.issue where id=v_id), 'CONCLUDED',
    '결론이 있으면 CONCLUDED 로 간다');

  -- 승인 없는 회신으로는 REPLIED 로 못 간다
  insert into public.reply (issue_id, body) values (v_id, '배터리를 교체했습니다.');
  v_r := false;
  begin
    update public.issue set status='REPLIED' where id=v_id;
  exception when others then v_r := true;
  end;
  perform public._assert(v_r, '승인되지 않은 회신으로는 REPLIED 로 갈 수 없다');

  -- 승인 전에 발송할 수 없다
  v_r := false;
  begin
    update public.reply set sent_at = now() where issue_id = v_id;
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '승인 전에는 발송 시각을 남길 수 없다');

  update public.reply set approved_at = now(), approved_by = null where issue_id = v_id;
  update public.issue set status='REPLIED' where id=v_id;
  perform public._assert_eq((select status from public.issue where id=v_id), 'REPLIED',
    '승인된 회신이 있으면 REPLIED 로 간다');

  -- ★ 핵심: 고객이 확인하지 않았는데 Knowledge 로 올릴 수 없다
  v_r := false;
  begin
    insert into public.knowledge (issue_id, title, root_cause, action)
    values (v_id, '시동 불량', '배터리 방전', '교체');
  exception when others then v_r := true;
  end;
  perform public._assert(v_r, '고객 확인 전에는 Knowledge 로 축적할 수 없다');

  -- 고객이 "해결 안 됐다"고 해도 안 된다
  insert into public.resolution (issue_id, confirmed, comment)
  values (v_id, false, '아직 같은 증상이 납니다');
  update public.issue set status='RESOLVED' where id=v_id;
  v_r := false;
  begin
    insert into public.knowledge (issue_id, title, root_cause, action)
    values (v_id, '시동 불량', '배터리 방전', '교체');
  exception when others then v_r := true;
  end;
  perform public._assert(v_r, '고객이 미해결이라고 하면 Knowledge 로 갈 수 없다');

  -- 확인되면 들어간다
  update public.resolution set confirmed = true where issue_id = v_id;
  insert into public.knowledge (issue_id, title, root_cause, action, prevention, tags)
  values (v_id, '시동 불량 — 배터리 방전', '배터리 방전', '배터리 교체', '월 1회 전압 점검',
          array['시동','배터리']);
  perform public._assert_eq(
    (select count(*) from public.knowledge where issue_id=v_id), 1::bigint,
    '고객이 확인한 사례는 Knowledge 로 축적된다');

  -- 해결 시각이 자동으로 채워졌는가
  perform public._assert(
    (select resolved_at from public.issue where id=v_id) is not null,
    'RESOLVED 로 가면 해결 시각이 자동으로 채워진다');

  -- 재발해서 되돌리면 해결 시각도 비워진다 (둘이 어긋나면 Knowledge 판정이 흔들린다)
  update public.issue set status='REPLIED' where id=v_id;
  perform public._assert(
    (select resolved_at from public.issue where id=v_id) is null,
    '되돌리면 해결 시각도 함께 비워진다');

  -- 질문은 3개까지
  v_r := false;
  begin
    insert into public.question (issue_id, seq, question) values (v_id, 4, '네 번째 질문');
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '판단을 바꿀 질문은 3개까지 (check 제약)');

  -- 역할 표기
  v_r := false;
  begin
    insert into public.app_user (user_id, name, roles)
    values ('33333333-3333-3333-3333-333333333333','X', array['superuser']);
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '정의되지 않은 역할은 check 제약이 막는다');

  v_r := false;
  begin
    insert into public.app_user (user_id, name, roles)
    values ('44444444-4444-4444-4444-444444444444','Y', array[]::text[]);
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '역할이 하나도 없는 사용자는 막는다');
end $t$;

delete from public.issue where code='T-1001';

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
