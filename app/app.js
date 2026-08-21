/**
 * Field-Insight MVP-1 — 단일 페이지 앱 (Phase 1: 브라우저 + 로컬 JS + Mock AI + LocalStorage)
 *
 * 화면: 접수자 C-01~05 / 전문가 E-01~05, 역할은 user.roles[] + 모드 토글(계정 분리 없음)
 * 저장: LocalStorage (Store 계층만 교체하면 Phase 2에서 서버/DB 전환 가능)
 */
(function () {
  "use strict";

  var S = window.FI_SCHEMA;
  var E = window.FI;
  var adapter = E.mockai.createMockAdapter(S.parts);
  var MNT = S.maintenance;

  /** 데모 사용자 — 역할은 사람 단위가 아니라 화면 모드 단위(원문 3장) */
  var USER = { name: "김현장", roles: ["reporter", "expert"] };

  /** 보유장비 목록 (MNT-12 장비 식별 — 질문 예산을 소모하지 않는 자동 획득, P5) */
  var EQUIPMENTS = [
    { model: "HX220A", sn: "3421", hours: 3410 },
    { model: "HX300L", sn: "1102", hours: 5230 },
    { model: "HW250", sn: "7789", hours: 820 },
    { model: "DX140W", sn: "0087", hours: 1250 }
  ];

  /* ────────────────────────── 저장 계층 (Phase 2 교체 지점) ────────────────────────── */
  var Store = {
    KEY: "field_insight_db_v1",
    empty: function () { return { issues: [], knowledge: [], next_no: 1024 }; },
    load: function () {
      try {
        var raw = localStorage.getItem(this.KEY);
        return raw ? JSON.parse(raw) : this.empty();
      } catch (e) { return this.empty(); }
    },
    save: function (db) {
      try { localStorage.setItem(this.KEY, JSON.stringify(db)); } catch (e) { /* 저장 불가 환경 */ }
    },
    reset: function () {
      try { localStorage.removeItem(this.KEY); } catch (e) {}
    }
  };

  var db = Store.load();

  var state = {
    mode: "reporter",       // reporter | expert
    view: "c04",            // reporter: c01/c02/c03/c04/cdetail/safety · expert: e01/edetail
    draft: null,            // 접수 진행 중 세션(DRAFT)
    current: null,          // 열려 있는 issue_id
    hl: null,               // 근거 하이라이트 {input_id, start, end}
    partQuery: "",
    opinionForm: null,      // E-04 작업 중 폼
    rewriteText: null       // E-05 편집 중 재작성문
  };

  /* ────────────────────────── 유틸 ────────────────────────── */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function now() { return new Date().toISOString(); }
  function fmt(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function elapsed(ts) {
    var h = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 3600000));
    if (h < 1) return "1시간 미만";
    if (h < 24) return h + "시간 경과";
    return Math.round(h / 24) + "일 경과";
  }
  function eqLabel(eq) {
    return eq ? eq.model + " · SN " + eq.sn + " · " + eq.hours.toLocaleString("ko-KR") + "h" : "장비 미지정";
  }
  function getIssue(no) {
    return db.issues.filter(function (i) { return i.issue_id === no; })[0] || null;
  }
  function scenarioOf(issue) {
    return (MNT.scenarios || []).filter(function (s) { return s.scenario_id === issue.scenario_id; })[0] || MNT.scenarios[0];
  }
  function reqOf(id) {
    return MNT.requirements.filter(function (r) { return r.requirement_id === id; })[0];
  }
  function collectedOf(issueOrDraft, reqId) {
    return (issueOrDraft.collected || []).filter(function (c) { return c.requirement_id === reqId; })[0] || null;
  }
  function notify(issue, text) {
    issue.notifications.push({ ts: now(), text: text }); // FR-22 진행 상태 알림
  }
  function sufficiencyOf(issue) {
    var g = E.gap.analyze(MNT, scenarioOf(issue), issue.collected);
    return Math.round(g.sufficiency * 100);
  }
  function makeTitle(collected) {
    var cond = null, sym = null;
    collected.forEach(function (c) {
      if (c.value_state !== "known") return;
      if (c.requirement_id === "MNT-03") cond = c.value;
      if (c.requirement_id === "MNT-01") sym = c.value;
    });
    if (cond && sym) return cond + " 시 " + sym;
    if (sym) return sym + " 현상";
    return "현장 이슈";
  }
  /** 확보 값 교체(동일 requirement 항목 대체) — 원본(UserInput)은 절대 수정하지 않는다(DP-1) */
  function upsertCollected(target, item) {
    var idx = -1;
    target.collected.forEach(function (c, i) { if (c.requirement_id === item.requirement_id) idx = i; });
    if (idx >= 0) target.collected[idx] = item; else target.collected.push(item);
  }

  /* ────────────────────────── 접수 흐름 로직 ────────────────────────── */

  /** C-01 → 분석: Intent/안전 감지 → 시나리오 → 추출 → 질문 생성 */
  function startAnalysis(text, equipment) {
    var intentResult = E.intent.classify(text, S.domains);
    var inputId = "input-" + Date.now();

    if (intentResult.safety_flag) {
      state.draft = { text: text, equipment: equipment, intentResult: intentResult, input_id: inputId };
      state.view = "safety";
      return;
    }

    var scenario = E.gap.pickScenario(text, MNT);
    var collected = E.gap.extract(text, MNT, scenario, inputId);
    // MNT-12 장비 식별 — 시스템 자동 획득 (source=system, confidence 1.0)
    collected.push({
      requirement_id: "MNT-12", label: "장비 식별(모델/SN/가동시간)",
      value: eqLabel(equipment), value_state: "known", coverage: "full",
      source_type: "system", confidence: E.confidence.confidenceFor("system"),
      evidence_ref: { input_id: null, type: "system", detail: "보유장비 선택" }
    });
    var questions = E.question.generateQuestions(MNT, scenario, collected);

    state.draft = {
      text: text, equipment: equipment, input_id: inputId,
      intentResult: intentResult, scenario: scenario,
      collected: collected, questions: questions, qIndex: 0
    };
    state.view = questions.length ? "c02" : "c03";
  }

  /** C-02 답변 반영 */
  function answerQuestion(q, answer, skipped) {
    q.answer = skipped ? null : answer;
    q.answered_at = now();
    var d = state.draft;
    if (skipped) {
      upsertCollected(d, {
        requirement_id: q.requirement_id, label: q.label, value: null,
        value_state: "skipped", coverage: "full", source_type: "answered", confidence: null,
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      });
    } else if (answer === E.question.UNKNOWN_OPTION) {
      upsertCollected(d, {
        requirement_id: q.requirement_id, label: q.label, value: null,
        value_state: "unknown", coverage: "full", source_type: "answered", confidence: null,
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      });
    } else {
      upsertCollected(d, {
        requirement_id: q.requirement_id, label: q.label, value: answer,
        value_state: "known", coverage: "full",
        source_type: "answered", confidence: E.confidence.confidenceFor("answered"),
        evidence_ref: { input_id: null, type: "answer", question_id: q.question_id }
      });
    }
    d.qIndex++;
    if (d.qIndex >= d.questions.length) state.view = "c03";
  }

  /** C-03 → Issue 생성 (FR-10: 사용자 접수 시점에 확정) */
  function submitIssue(opts) {
    var d = state.draft;
    var no = db.next_no++;
    var issue = {
      issue_id: no,
      status: "DRAFT",
      title: makeTitle(d.collected),
      domain: d.intentResult.domain,
      intent: d.intentResult.intent,
      scenario_id: d.scenario ? d.scenario.scenario_id : null,
      safety_level: (opts && opts.safety) ? "긴급" : "일반",
      priority: (opts && opts.safety) ? "긴급" : "보통",
      equipment_ref: d.equipment,
      assignee_id: "expert-demo",
      linked_issues: [],
      /* DP-1/FR-03: 고객 원본은 불변 저장, AI 해석(collected)과 분리 */
      user_input: {
        input_id: d.input_id, input_type: "text",
        original_text: d.text, created_at: now(),
        metadata: d.equipment ? { model: d.equipment.model, sn: d.equipment.sn, hours: d.equipment.hours } : null
      },
      intent_result: d.intentResult,
      collected: d.collected,
      questions: d.questions || [],
      expert_checks: d.scenario ? E.question.expertCheckItems(MNT, d.scenario, d.collected) : [],
      ai_analysis: null,
      expert_opinion: null,
      customer_response: null,
      feedback: [],
      reopen_count: 0,
      pending_request: null,
      notifications: [],
      audit: [],
      knowledge_entry: null,
      created_at: now()
    };
    E.statemachine.appendAudit(issue, "issue_created",
      { domain: issue.domain, scenario: issue.scenario_id, safety: issue.safety_level }, "접수자");
    E.statemachine.transition(issue, "SUBMITTED", { actor: "접수자", note: "사용자 접수" });
    notify(issue, "접수되었습니다 (#" + no + ") · 예상 회신 24시간");
    E.statemachine.transition(issue, "ASSIGNED", { actor: "system", note: "자동 배정: 전문가 데모 계정" });
    notify(issue, "담당 전문가가 확인 중입니다");
    db.issues.push(issue);
    Store.save(db);
    state.draft = null;
    state.current = no;
    state.view = "cdetail";
    return issue;
  }

  /* ────────────────────────── 렌더링 ────────────────────────── */
  var root = document.getElementById("root");

  function render() {
    document.getElementById("mode-reporter").className = state.mode === "reporter" ? "active" : "";
    document.getElementById("mode-expert").className = state.mode === "expert" ? "active" : "";
    var html = "";
    if (state.mode === "reporter") {
      if (state.view === "c01") html = viewC01();
      else if (state.view === "c02") html = viewC02();
      else if (state.view === "c03") html = viewC03();
      else if (state.view === "safety") html = viewSafety();
      else if (state.view === "cdetail") html = viewCDetail();
      else html = viewC04();
    } else {
      if (state.view === "edetail") html = viewEDetail();
      else html = viewE01();
    }
    root.innerHTML = html;
    var mk = root.querySelector("mark.hl");
    if (mk) mk.scrollIntoView({ block: "center" });
  }

  /* ── C-01 입력 + 장비 선택 ── */
  function viewC01() {
    return '' +
      '<section class="card" id="view-c01">' +
      '<h2>무슨 일이 있었나요? <span class="sr">(C-01)</span></h2>' +
      '<p class="muted">전문용어 없이, 겪으신 그대로 적어 주세요. 필요한 정보는 저희가 여쭤봅니다.</p>' +
      '<label class="fld" for="input-text">현상 설명</label>' +
      '<textarea id="input-text" placeholder="예) 붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다."></textarea>' +
      '<label class="fld" for="select-equipment">장비 선택 (보유장비)</label>' +
      '<select id="select-equipment">' +
      EQUIPMENTS.map(function (e, i) {
        return '<option value="' + i + '">' + esc(eqLabel(e)) + '</option>';
      }).join("") +
      '</select>' +
      '<p class="muted" style="margin-top:6px">장비 식별(MNT-12)은 자동 획득 — 질문 예산을 쓰지 않습니다.</p>' +
      '<button class="primary" id="btn-analyze" data-action="analyze">다음 (내용 분석)</button>' +
      '<button class="back" data-action="go-c04">← 내 접수 목록</button>' +
      '</section>';
  }

  /* ── 안전 위험 분기 (FR-05) ── */
  function viewSafety() {
    var hits = (state.draft.intentResult.safety_hits || []).map(function (h) { return h.keyword; });
    return '' +
      '<section class="safety" id="view-safety">' +
      '<h2>🚨 안전 위험이 감지되었습니다</h2>' +
      '<p>입력 내용에서 위험 신호(<b>' + esc(hits.join(", ")) + '</b>)가 확인되어 <b>정보 수집을 중단</b>했습니다.</p>' +
      '<ul>' +
      '<li>즉시 장비를 정지하고 안전한 곳으로 대피하세요.</li>' +
      '<li>긴급 상황이면 <b>사내 안전상황실(내선 119)</b> 또는 119로 연락하세요.</li>' +
      '<li>아래 버튼으로 긴급 접수하면 추가 질문 없이 전문가에게 즉시 전달됩니다.</li>' +
      '</ul>' +
      '<div class="row-actions">' +
      '<button class="danger" id="btn-safety-submit" data-action="safety-submit">긴급 접수하기</button>' +
      '<button class="ghost" data-action="go-c01">돌아가기</button>' +
      '</div>' +
      '</section>';
  }

  /* ── C-02 선택지 질문 (진행 표시, [모르겠음], [건너뛰기]) ── */
  function viewC02() {
    var d = state.draft;
    var q = d.questions[d.qIndex];
    var freeInput = q.answer_type === "free_choice"
      ? '<div class="freeinput-row"><input type="text" id="free-answer" placeholder="직접 입력">' +
        '<button class="ghost" data-action="answer-free">확인</button></div>'
      : "";
    return '' +
      '<section class="card question-card" id="view-c02">' +
      '<div class="progress" id="q-progress">' + d.questions.length + '가지만 확인할게요 (' + (d.qIndex + 1) + '/' + d.questions.length + ')</div>' +
      '<div class="qtitle" id="q-text">' + esc(q.question_text) + '</div>' +
      '<p class="muted">' + esc(q.label) + ' · 판단영향도 ' + q.decision_impact.toFixed(1) + '</p>' +
      '<div class="opt-grid">' +
      q.options.map(function (o) {
        return '<button class="opt option-btn" data-action="answer" data-value="' + esc(o) + '">' + esc(o) + '</button>';
      }).join("") +
      '</div>' + freeInput +
      '<div class="row-actions">' +
      '<button class="ghost" id="btn-skip" data-action="skip">건너뛰기</button>' +
      '</div>' +
      '</section>';
  }

  /* ── C-03 선택적 확인 (저신뢰 상위 2개만 강조, DP-4) ── */
  function viewC03() {
    var d = state.draft;
    var targets = E.confidence.confirmTargets(d.collected, MNT);
    var targetIds = targets.map(function (t) { return t.requirement_id; });
    var rows = E.gap.scenarioRequirements(MNT, d.scenario).map(function (req) {
      var c = collectedOf(d, req.requirement_id);
      if (targetIds.indexOf(req.requirement_id) >= 0) return ""; // 강조 박스에서 별도 표시
      var val;
      if (c && c.value_state === "known") val = esc(c.value);
      else if (c && c.value_state === "unknown") val = '<span class="value-missing">모르겠음(unknown)</span>';
      else if (c && c.value_state === "skipped") val = '<span class="value-missing">건너뜀</span>';
      else if (req.ask_policy === "expert_check") val = '<span class="value-missing">정보 부족 → 전문가 확인 항목</span>';
      else val = '<span class="value-missing">미확보</span>';
      var editable = req.ask_policy === "ask";
      return '<tr><td class="k">' + esc(req.label) + '</td><td>' + val + '</td>' +
        '<td class="a">' + (editable ? '<button class="editbtn" data-action="edit-field" data-req="' + req.requirement_id + '" title="수정">✎</button>' : "") + '</td></tr>';
    }).join("");

    var boxes = targets.map(function (t) {
      var req = reqOf(t.requirement_id);
      var opts = (req.options || []).map(function (o) {
        return '<button class="opt" data-action="confirm-fix" data-req="' + req.requirement_id + '" data-value="' + esc(o) + '">' + esc(o) + '</button>';
      }).join("");
      return '<div class="warnbox lowconf-box" data-req="' + req.requirement_id + '">' +
        '<div class="t">⚠ 이 항목만 확인해 주세요 — ' + esc(req.label) + '</div>' +
        '<p>"<b>' + esc(t.value) + '</b>" 으로 이해했습니다. (신뢰도 ' + t.confidence + ')</p>' +
        '<div class="opt-grid">' +
        '<button class="opt btn-confirm-ok" data-action="confirm-ok" data-req="' + req.requirement_id + '">맞아요</button>' +
        opts +
        '</div></div>';
    }).join("");

    var editForm = "";
    if (state.editReq) {
      var er = reqOf(state.editReq);
      editForm = '<div class="warnbox"><div class="t">✎ ' + esc(er.label) + ' 수정</div><div class="opt-grid">' +
        (er.options || []).concat([E.question.UNKNOWN_OPTION]).filter(function (v, i, a) { return a.indexOf(v) === i; })
          .map(function (o) {
            return '<button class="opt" data-action="confirm-fix" data-req="' + er.requirement_id + '" data-value="' + esc(o) + '">' + esc(o) + '</button>';
          }).join("") +
        '</div></div>';
    }

    return '' +
      '<section class="card" id="view-c03">' +
      '<h2>이렇게 이해했습니다 <span class="sr">(C-03)</span></h2>' +
      '<p class="muted">' + esc(eqLabel(d.equipment)) + ' · ' + esc(d.scenario.label) + '</p>' +
      '<table class="fields">' + rows + '</table>' +
      boxes + editForm +
      '<div class="origin">고객 원문 “' + esc(d.text) + '”</div>' +
      '<button class="primary" id="btn-submit-issue" data-action="submit-issue">접수하기</button>' +
      '</section>';
  }

  /* ── C-04 내 접수 목록 ── */
  function viewC04() {
    var mine = db.issues.slice().reverse();
    var items = mine.length ? mine.map(function (i) {
      return '<div class="issue-item" data-action="open-cdetail" data-no="' + i.issue_id + '">' +
        '<span class="no">#' + i.issue_id + '</span>' +
        '<span class="grow"><span class="t">' + esc(i.title) + '</span><br><span class="muted">' + esc(eqLabel(i.equipment_ref)) + ' · ' + fmt(i.created_at) + '</span></span>' +
        '<span class="badge status-badge b-' + i.status + '">' + esc(E.statemachine.LABELS[i.status] || i.status) + '</span>' +
        '</div>';
    }).join("") : '<p class="muted" style="padding:12px 0">접수한 이슈가 없습니다. 새 이슈를 접수해 보세요.</p>';
    return '' +
      '<section class="card" id="view-c04">' +
      '<h2>내 접수 목록 <span class="sr">(C-04)</span></h2>' +
      '<div id="issue-list">' + items + '</div>' +
      '<button class="primary" id="btn-new-issue" data-action="go-c01">+ 새 이슈 접수</button>' +
      '</section>';
  }

  /* ── C-04 상세 + C-05 답변 확인/해결 응답 ── */
  function viewCDetail() {
    var issue = getIssue(state.current);
    if (!issue) { state.view = "c04"; return viewC04(); }
    var html = '<button class="back" data-action="go-c04">← 목록</button>';

    html += '<section class="card">' +
      '<h2>#' + issue.issue_id + ' ' + esc(issue.title) + ' ' +
      '<span class="badge status-badge b-' + issue.status + '" id="cdetail-status">' + esc(E.statemachine.LABELS[issue.status]) + '</span></h2>' +
      '<p class="muted">' + esc(eqLabel(issue.equipment_ref)) + ' · ' + fmt(issue.created_at) + '</p>' +
      '<div class="origin">내가 말한 내용 “' + esc(issue.user_input.original_text) + '”</div>' +
      '</section>';

    // 진행 알림 (FR-22)
    html += '<section class="card"><h3>진행 알림</h3><ul class="timeline">' +
      issue.notifications.map(function (n) {
        return '<li><span class="ts">' + fmt(n.ts) + '</span>' + esc(n.text) + '</li>';
      }).join("") + '</ul></section>';

    // PENDING_FIELD: 현장 확인 요청 회신 (회신 루프)
    if (issue.status === "PENDING_FIELD" && issue.pending_request) {
      html += '<section class="card"><h3>📋 현장에서 확인이 필요한 항목</h3>' +
        '<ul style="margin-left:18px">' + issue.pending_request.items.map(function (it) { return '<li>' + esc(it) + '</li>'; }).join("") + '</ul>' +
        '<label class="fld" for="pending-reply">확인 결과</label>' +
        '<textarea id="pending-reply" placeholder="예) 예열 10분 후에는 증상이 없었습니다."></textarea>' +
        '<button class="primary" id="btn-send-reply" data-action="send-pending-reply">확인 내용 보내기</button>' +
        '</section>';
    }

    // C-05 답변 확인 + 해결 여부 응답
    if (issue.customer_response && ["ANSWERED", "RESOLVED", "REOPENED", "KNOWLEDGE_READY"].indexOf(issue.status) >= 0) {
      html += '<section class="card" id="answer-view"><h3>전문가 답변 <span class="sr">(C-05)</span></h3>' +
        '<div class="origin" id="customer-answer">' + esc(issue.customer_response.simplified_response) + '</div>' +
        '<p class="muted" style="margin-top:6px">발송 ' + fmt(issue.customer_response.delivered_at) + ' · 승인 ' + esc(issue.customer_response.approved_by) + '</p>';
      if (issue.status === "ANSWERED") {
        html += '<p style="margin-top:12px"><b>문제가 해결되었나요?</b></p>' +
          '<div class="row-actions">' +
          '<button class="okbtn" id="btn-resolved" data-action="feedback-resolved">해결됨</button>' +
          '<button class="danger" id="btn-unresolved" data-action="feedback-unresolved">해결 안 됨</button>' +
          '<button class="ghost" id="btn-requestion" data-action="feedback-requestion">다시 질문</button>' +
          '</div>';
      } else if (issue.status === "RESOLVED" || issue.status === "KNOWLEDGE_READY") {
        html += '<p class="notice" id="resolved-note">✅ 해결 확인 감사합니다.' +
          (issue.status === "KNOWLEDGE_READY" ? " 이 사례는 검증된 지식(Knowledge) 승격 후보로 등록되었습니다." : "") + '</p>';
      } else if (issue.status === "REOPENED") {
        html += '<p class="notice">전문가가 다시 검토 중입니다 (REOPENED · 재검토 ' + issue.reopen_count + '회).</p>';
      }
      html += '</section>';
    }
    return html;
  }

  /* ── E-01 My Queue (진행중 / 정보대기 레인 분리) ── */
  function viewE01() {
    var active = [], waiting = [], done = [];
    db.issues.forEach(function (i) {
      if (["SUBMITTED", "ASSIGNED", "IN_REVIEW", "REOPENED"].indexOf(i.status) >= 0) active.push(i);
      else if (i.status === "PENDING_FIELD") waiting.push(i);
      else done.push(i);
    });
    function card(i) {
      var checks = (i.expert_checks || []).map(function (c) { return c.label; });
      return '<div class="queue-card" data-no="' + i.issue_id + '">' +
        '<div class="head"><span class="no">● #' + i.issue_id + '</span> <span>' + esc(i.title) + '</span>' +
        '<span class="suff">정보충분도 ' + sufficiencyOf(i) + '%</span></div>' +
        '<div class="meta">' + esc(eqLabel(i.equipment_ref)) +
        (checks.length ? ' · ⚠ ' + esc(checks.join("·")) + ' 미확보' : "") +
        ' · ⏱ ' + elapsed(i.created_at) +
        ' · <span class="badge b-' + i.status + '">' + esc(E.statemachine.LABELS[i.status]) + '</span></div>' +
        '<button class="ghost btn-open" data-action="open-edetail" data-no="' + i.issue_id + '">열기</button>' +
        '</div>';
    }
    return '' +
      '<section class="card" id="view-e01">' +
      '<h2>내 작업 <span class="sr">(E-01 My Queue)</span></h2>' +
      '<p class="muted">진행중 ' + active.length + ' · 정보대기 ' + waiting.length + ' · 완료 ' + done.length + '</p>' +
      '<div class="lane-title">진행중 (' + active.length + ')</div>' +
      '<div id="queue-active">' + (active.map(card).join("") || '<p class="muted">진행중 이슈가 없습니다.</p>') + '</div>' +
      '<div class="lane-title">▸ 정보 대기 (' + waiting.length + ') — 고객 응답 대기 중</div>' +
      '<div id="queue-waiting">' + (waiting.map(card).join("") || '<p class="muted">정보 대기 이슈가 없습니다.</p>') + '</div>' +
      '<div class="lane-title">완료·종결 (' + done.length + ')</div>' +
      '<div id="queue-done">' + (done.map(card).join("") || '<p class="muted">완료된 이슈가 없습니다.</p>') + '</div>' +
      '</section>';
  }

  /* ── E-02~E-05 이슈 상세 (다음 단계에서 구현) ── */
  function viewEDetail() {
    return '<section class="card"><h2>이슈 상세</h2><p class="muted">전문가 상세 화면(E-02~05)은 다음 커밋에서 제공됩니다.</p></section>';
  }

  /* ────────────────────────── 액션 처리 ────────────────────────── */

  function syncOpinionForm() {
    var f = state.opinionForm;
    if (!f) return;
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
    if (g("expert-free-text") != null) f.free_text = g("expert-free-text");
    if (g("action-type") != null) f.action_type = g("action-type");
    if (g("action-detail") != null) f.action_detail = g("action-detail");
    if (g("rationale-text") != null) f.rationale_text = g("rationale-text");
    if (g("prevention") != null) f.prevention = g("prevention");
    if (g("undetermined-reason") != null) f.reason = g("undetermined-reason");
    var chk = document.getElementById("chk-undetermined");
    if (chk) f.undetermined = chk.checked;
    f.refs = {};
    Array.prototype.forEach.call(document.querySelectorAll(".rationale-check"), function (c) {
      if (c.checked) f.refs[c.getAttribute("data-ref")] = true;
    });
    var ps = document.getElementById("part-search");
    if (ps) state.partQuery = ps.value;
  }

  function openExpertIssue(no) {
    var issue = getIssue(no);
    if (!issue) return;
    // 큐에서 열기: SUBMITTED→ASSIGNED→IN_REVIEW, REOPENED→IN_REVIEW (상태머신 준수)
    if (issue.status === "SUBMITTED") E.statemachine.transition(issue, "ASSIGNED", { actor: "system", note: "전문가 열람 시 자동 배정" });
    if (issue.status === "ASSIGNED") E.statemachine.transition(issue, "IN_REVIEW", { actor: "전문가", note: "검토 시작" });
    if (issue.status === "REOPENED") E.statemachine.transition(issue, "IN_REVIEW", { actor: "전문가", note: "재검토 시작" });
    Store.save(db);
    state.current = no;
    state.view = "edetail";
    state.hl = null;
    state.opinionForm = null;
    state.partQuery = "";
    state.rewriteText = null;
  }

  function handleAction(action, el) {
    var issue = state.current != null ? getIssue(state.current) : null;

    switch (action) {
      /* 내비게이션 */
      case "go-c01": state.view = "c01"; state.draft = null; break;
      case "go-c04": state.view = "c04"; state.editReq = null; break;
      case "go-e01": state.view = "e01"; state.hl = null; break;
      case "open-cdetail": state.current = parseInt(el.getAttribute("data-no"), 10); state.view = "cdetail"; break;
      case "open-edetail": openExpertIssue(parseInt(el.getAttribute("data-no"), 10)); break;

      /* C-01 → 분석 */
      case "analyze": {
        var text = document.getElementById("input-text").value.trim();
        if (!text) { alert("현상을 입력해 주세요."); return; }
        var eq = EQUIPMENTS[parseInt(document.getElementById("select-equipment").value, 10)];
        startAnalysis(text, eq);
        break;
      }
      case "safety-submit": {
        // 안전 분기: 질문 없이 긴급 접수 (FR-05)
        var d = state.draft;
        d.scenario = E.gap.pickScenario(d.text, MNT);
        d.collected = E.gap.extract(d.text, MNT, d.scenario, d.input_id);
        d.questions = [];
        submitIssue({ safety: true });
        break;
      }

      /* C-02 */
      case "answer": answerQuestion(state.draft.questions[state.draft.qIndex], el.getAttribute("data-value"), false); break;
      case "answer-free": {
        var v = document.getElementById("free-answer").value.trim();
        if (!v) return;
        answerQuestion(state.draft.questions[state.draft.qIndex], v, false);
        break;
      }
      case "skip": answerQuestion(state.draft.questions[state.draft.qIndex], null, true); break;

      /* C-03 */
      case "confirm-ok": {
        var c1 = collectedOf(state.draft, el.getAttribute("data-req"));
        if (c1) {
          c1.source_type = "answered"; // 고객이 직접 확인 → 출처 상승
          c1.confidence = E.confidence.confidenceFor("answered");
          c1.confirmed = true;
          c1.coverage = "full";
        }
        break;
      }
      case "confirm-fix": {
        var reqId = el.getAttribute("data-req");
        var val = el.getAttribute("data-value");
        var req2 = reqOf(reqId);
        if (val === E.question.UNKNOWN_OPTION) {
          upsertCollected(state.draft, {
            requirement_id: reqId, label: req2.label, value: null, value_state: "unknown",
            coverage: "full", source_type: "answered", confidence: null,
            evidence_ref: { input_id: null, type: "answer", question_id: "confirm" }
          });
        } else {
          upsertCollected(state.draft, {
            requirement_id: reqId, label: req2.label, value: val, value_state: "known",
            coverage: "full", source_type: "answered",
            confidence: E.confidence.confidenceFor("answered"), confirmed: true,
            evidence_ref: { input_id: null, type: "answer", question_id: "confirm" }
          });
        }
        state.editReq = null;
        break;
      }
      case "edit-field": state.editReq = el.getAttribute("data-req"); break;
      case "submit-issue": state.editReq = null; submitIssue(); break;

      /* C-04/05 회신 루프 */
      case "send-pending-reply": {
        var reply = document.getElementById("pending-reply").value.trim();
        if (!reply) { alert("확인 결과를 입력해 주세요."); return; }
        issue.pending_request.reply = reply;
        issue.pending_request.replied_at = now();
        E.statemachine.appendAudit(issue, "field_reply", { reply: reply }, "접수자");
        E.statemachine.transition(issue, "IN_REVIEW", { actor: "system", note: "고객 확인 회신 수신" });
        notify(issue, "확인 내용이 전문가에게 전달되었습니다");
        Store.save(db);
        break;
      }
      case "feedback-resolved": {
        issue.feedback.push({ result: "resolved", comment: null, responded_at: now() });
        E.statemachine.transition(issue, "RESOLVED", { actor: "접수자", note: "고객 해결 확인" });
        // Knowledge 승격 게이트: RESOLVED + 원인 확정 + 승인 사례만 (DP-8)
        var op1 = issue.expert_opinion;
        if (op1 && !op1.cause_undetermined && issue.customer_response && issue.customer_response.approved_at) {
          E.statemachine.transition(issue, "KNOWLEDGE_READY", { actor: "system", note: "Knowledge 승격 후보 등록(검증된 사례)" });
          issue.knowledge_entry = {
            source_issue_id: issue.issue_id, verified: true,
            curated_by: null, reuse_count: 0, created_at: now()
          };
          db.knowledge.push(issue.knowledge_entry);
        }
        notify(issue, "해결 확인 완료 — 감사합니다");
        Store.save(db);
        break;
      }
      case "feedback-unresolved": {
        issue.feedback.push({ result: "unresolved", comment: null, responded_at: now() });
        issue.reopen_count++;
        E.statemachine.transition(issue, "REOPENED", { actor: "접수자", note: "해결 안 됨 → 재검토" });
        notify(issue, "재검토를 요청했습니다. 전문가가 다시 확인합니다");
        Store.save(db);
        break;
      }
      case "feedback-requestion": {
        var cm = window.prompt("추가로 궁금한 내용을 입력해 주세요.", "");
        if (cm == null) return;
        issue.feedback.push({ result: "more_question", comment: cm, responded_at: now() });
        issue.reopen_count++;
        E.statemachine.transition(issue, "REOPENED", { actor: "접수자", note: "다시 질문: " + cm });
        notify(issue, "질문이 전문가에게 전달되었습니다");
        Store.save(db);
        break;
      }

    }
    render();
  }

  /* ────────────────────────── 이벤트 바인딩 ────────────────────────── */
  root.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-action]");
    if (!el) return;
    handleAction(el.getAttribute("data-action"), el);
  });
  root.addEventListener("input", function (ev) {
    if (ev.target.id === "part-search") {
      syncOpinionForm();
      state.partQuery = ev.target.value;
      render();
      var ps = document.getElementById("part-search");
      if (ps) { ps.focus(); ps.setSelectionRange(ps.value.length, ps.value.length); }
    }
  });
  root.addEventListener("change", function (ev) {
    if (ev.target.id === "chk-undetermined") {
      syncOpinionForm();
      render();
    }
  });

  document.getElementById("mode-reporter").addEventListener("click", function () {
    state.mode = "reporter"; state.view = "c04"; state.hl = null; render();
  });
  document.getElementById("mode-expert").addEventListener("click", function () {
    state.mode = "expert"; state.view = "e01"; state.hl = null; render();
  });
  document.getElementById("btn-reset").addEventListener("click", function () {
    if (!confirm("모든 로컬 데이터를 초기화할까요?")) return;
    Store.reset();
    db = Store.load();
    state.mode = "reporter"; state.view = "c04"; state.current = null; state.draft = null;
    render();
  });
  document.getElementById("btn-load-seed").addEventListener("click", function () {
    if (!window.FI_SEED) { alert("시드 스크립트를 찾을 수 없습니다."); return; }
    var no = window.FI_SEED.load(db, { schema: S, engine: E, adapter: adapter });
    Store.save(db);
    state.mode = "expert"; state.view = "e01"; state.current = no;
    render();
  });

  render();
})();
