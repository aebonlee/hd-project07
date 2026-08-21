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

  /* ── E-02~E-05 이슈 상세 (근거 점프 · AI 분석 · 구조화 결론 · 승인) ── */
  function viewEDetail() {
    var issue = getIssue(state.current);
    if (!issue) { state.view = "e01"; return viewE01(); }
    var scenario = scenarioOf(issue);
    var g = E.gap.analyze(MNT, scenario, issue.collected);

    var html = '<button class="back" data-action="go-e01">← My Queue</button>';

    /* E-02: 정형화 결과 + 원본 근거 점프 */
    var rows = g.rows.filter(function (r) { return r.requirement_id !== "MNT-12"; }).map(function (r) {
      var c = r.item;
      var val, evi = "—";
      if (c && c.value_state === "known") {
        val = esc(c.value);
        var ref = c.evidence_ref || {};
        if (ref.input_id) {
          evi = '<button class="evi evidence-link" data-action="jump" data-input="' + esc(ref.input_id) + '" data-start="' + ref.start + '" data-end="' + ref.end + '">📄 원문 ' + ref.start + '–' + ref.end + '</button>';
        } else if (ref.type === "answer") {
          evi = '<span class="evi">💬 ' + esc((ref.question_id || "").split("-")[0] || "질문") + ' 응답</span>';
        } else if (ref.type === "system") {
          evi = '<span class="evi">⚙ 시스템 획득</span>';
        }
        if (c.source_type === "answered" && c.confirmed) val += ' <span class="sr">(고객 확인됨)</span>';
      } else if (c && c.value_state === "unknown") {
        val = '<span class="value-missing">모르겠음(unknown)</span>';
      } else if (c && c.value_state === "skipped") {
        val = '<span class="value-missing">건너뜀(skipped)</span>';
      } else {
        val = '<span class="value-missing">' + (r.ask_policy === "expert_check" ? "미확보 (계측 필요)" : "미확보") + '</span>';
      }
      return '<tr><td class="k">' + esc(r.label) + '</td><td>' + val + '</td><td style="text-align:right">' + evi + '</td></tr>';
    }).join("");

    var originalHtml = esc(issue.user_input.original_text);
    if (state.hl && state.hl.input_id === issue.user_input.input_id) {
      var t = issue.user_input.original_text;
      originalHtml = esc(t.slice(0, state.hl.start)) +
        '<mark class="hl">' + esc(t.slice(state.hl.start, state.hl.end)) + '</mark>' +
        esc(t.slice(state.hl.end));
    }

    html += '<section class="card" id="issue-detail">' +
      '<h2>ISSUE #' + issue.issue_id + ' <span class="badge b-' + issue.status + '" id="edetail-status">' + esc(E.statemachine.LABELS[issue.status]) + '</span></h2>' +
      '<p class="muted">정비 · ' + esc(issue.safety_level) + ' · ' + esc(eqLabel(issue.equipment_ref)) + ' · ' + fmt(issue.created_at) + ' · 정보충분도 ' + Math.round(g.sufficiency * 100) + '%</p>' +
      '<h3>정형화 결과 <span class="sr">(E-02 · 근거 클릭 시 원문 하이라이트)</span></h3>' +
      '<table class="fields">' + rows + '</table>' +
      ((issue.expert_checks || []).length ?
        '<p class="notice" style="margin-top:10px">🔧 전문가 추가 확인 항목: ' +
        esc(issue.expert_checks.map(function (c) { return c.label; }).join(", ")) +
        ' <span class="sr">(획득가능성 ‘하’ — 고객에게 묻지 않음)</span></p>' : "") +
      '<h3>고객 원문</h3>' +
      '<div class="origin" id="original-text">“' + originalHtml + '”</div>' +
      (issue.pending_request && issue.pending_request.reply ?
        '<h3>현장 확인 회신</h3><div class="origin">“' + esc(issue.pending_request.reply) + '”</div>' : "") +
      '</section>';

    /* E-03: Mock AI 분석 */
    html += '<section class="card" id="ai-section"><h3>AI 1차 분석 <span class="sr">(E-03 · Mock Rule Engine)</span></h3>';
    if (!issue.ai_analysis) {
      html += '<p class="muted">표준·매뉴얼·과거사례(Mock 저장소)를 근거로 A/B/C/D 판정을 제시합니다.</p>' +
        '<button class="primary" id="btn-run-ai" data-action="run-ai">AI 분석 실행</button>';
    } else {
      var a = issue.ai_analysis;
      html += '<div id="ai-result">' +
        '<span class="verdict v' + a.verdict + '">판정 ' + a.verdict + ' — ' + esc(a.verdict_label) + '</span>' +
        '<p>' + esc(a.recommendation) + '</p>' +
        (a.similar_cases || []).map(function (c) {
          return '<div class="simcase">🔗 <b>' + esc(c.case_id) + '</b> (' + Math.round(c.similarity * 100) + '%) ' + esc(c.title) +
            '<br><span class="muted">' + esc(c.resolution) + '</span></div>';
        }).join("") +
        (a.related_documents || []).map(function (dcm) {
          return '<div class="simcase">📘 <b>' + esc(dcm.doc_id) + '</b> ' + esc(dcm.title) + '</div>';
        }).join("") +
        ((a.evidence || []).length ? '<p class="muted">근거: ' + esc(a.evidence.join(" / ")) + '</p>' : "") +
        '<div class="limbox">⚠ ' + esc(a.limitations) + '</div>';
      if (a.verdict === "D" && issue.status === "IN_REVIEW") {
        html += '<p class="muted" style="margin-top:8px">추가 필요 정보: ' + esc((a.missing_info || []).join(", ")) + '</p>' +
          '<button class="primary" id="btn-request-field" data-action="request-field">고객에게 추가 확인 요청</button>';
      }
      html += '</div>';
    }
    html += '</section>';

    /* E-04: 구조화 결론 (자유 서술 → AI 초안 → 4필드) */
    var opinionDone = !!issue.expert_opinion;
    var canConclude = issue.status === "IN_REVIEW";
    if (opinionDone) {
      var op = issue.expert_opinion;
      html += '<section class="card" id="opinion-section"><h3>구조화 결론 (확정) <span class="sr">(E-04)</span></h3>' +
        '<table class="fields">' +
        '<tr><td class="k">확정 원인</td><td id="final-cause">' +
        (op.cause_undetermined
          ? '원인 미확정 · 사유: ' + esc(op.cause_undetermined_reason_label || op.cause_undetermined_reason)
          : esc(op.cause_system_label) + ' / ' + esc(op.cause_part_label) + ' <span class="code-chip">' + esc(op.cause_part_code) + '</span>') +
        '</td></tr>' +
        '<tr><td class="k">조치 내용</td><td>' + esc(op.action_detail) + ' <span class="badge">' + esc(op.action_type) + '</span></td></tr>' +
        '<tr><td class="k">판단 근거</td><td>' + esc((op.rationale_refs || []).join(" · ")) + (op.rationale_text ? '<br><span class="muted">' + esc(op.rationale_text) + '</span>' : "") + '</td></tr>' +
        '<tr><td class="k">재발 방지</td><td>' + esc(op.prevention || "—") + '</td></tr>' +
        '</table><p class="muted">확정 ' + fmt(op.finalized_at) + '</p></section>';
    } else if (canConclude) {
      html += viewE04Form(issue);
    } else {
      html += '<section class="card section-disabled"><h3>구조화 결론 <span class="sr">(E-04)</span></h3>' +
        '<p class="muted">검토 중(IN_REVIEW) 상태에서 입력할 수 있습니다.</p></section>';
    }

    /* E-05: 고객 답변 승인 */
    if (issue.customer_response) {
      html += '<section class="card"><h3>고객 회신 (발송 완료) <span class="sr">(E-05)</span></h3>' +
        '<div class="compare">' +
        '<div class="pane"><h4>전문가 원본</h4>' + esc(issue.customer_response.technical_original) + '</div>' +
        '<div class="pane"><h4>고객용 재작성 (발송본)</h4>' + esc(issue.customer_response.simplified_response) + '</div>' +
        '</div><p class="muted">승인 ' + esc(issue.customer_response.approved_by) + ' · ' + fmt(issue.customer_response.approved_at) + '</p></section>';
    } else if (opinionDone && issue.status === "IN_REVIEW") {
      var tech = issue.expert_opinion.original_text || issue.expert_opinion.rationale_text || "";
      if (state.rewriteText == null) state.rewriteText = adapter.rewriteForCustomer(tech);
      html += '<section class="card" id="approval-view"><h3>고객 답변 승인 <span class="sr">(E-05 · 발송 전 1-click 승인 게이트)</span></h3>' +
        '<div class="compare">' +
        '<div class="pane"><h4>전문가 원본 (불변 저장)</h4><span id="tech-original">' + esc(tech) + '</span></div>' +
        '<div class="pane"><h4>AI 고객용 재작성 (치환 템플릿)</h4>' +
        '<textarea id="customer-rewrite">' + esc(state.rewriteText) + '</textarea>' +
        '<p class="muted">[수정]: 위 텍스트를 직접 편집하세요. 전문가 원본은 덮어쓰지 않습니다.</p></div>' +
        '</div>' +
        '<button class="primary" id="btn-approve-send" data-action="approve-send">승인 후 발송</button>' +
        '</section>';
    }

    /* 감사 이력 (FR-25) */
    html += '<section class="card"><h3>감사 이력 <span class="sr">(FR-25 · append-only)</span></h3><div class="audit" id="audit-trail">' +
      issue.audit.map(function (a) {
        var d = a.detail ? (a.detail.from ? a.detail.from + " → " + a.detail.to + (a.detail.note ? " (" + a.detail.note + ")" : "") : JSON.stringify(a.detail)) : "";
        return '<div>#' + a.seq + ' · ' + fmt(a.ts) + ' · ' + esc(a.actor) + ' · ' + esc(a.event) + ' ' + esc(d) + '</div>';
      }).join("") +
      '</div></section>';

    return html;
  }

  /** E-04 입력 폼 */
  function viewE04Form(issue) {
    var f = state.opinionForm || (state.opinionForm = {
      free_text: "", part_code: null, undetermined: false, reason: "",
      action_type: "", action_detail: "", refs: {}, rationale_text: "", prevention: ""
    });
    var selectedPart = f.part_code ? S.parts.parts.filter(function (p) { return p.part_code === f.part_code; })[0] : null;
    var selectedSystem = selectedPart ? S.parts.systems.filter(function (s) { return s.system_code === selectedPart.system_code; })[0] : null;

    var q = (state.partQuery || "").trim();
    var results = "";
    if (q) {
      var found = S.parts.parts.filter(function (p) {
        var sys = S.parts.systems.filter(function (s) { return s.system_code === p.system_code; })[0];
        var hay = p.part_code + " " + p.label + " " + (sys ? sys.label + " " + sys.group : "");
        return hay.toLowerCase().indexOf(q.toLowerCase()) >= 0;
      }).slice(0, 8);
      results = '<div class="part-results">' +
        (found.length ? found.map(function (p) {
          var sys = S.parts.systems.filter(function (s) { return s.system_code === p.system_code; })[0];
          return '<button class="part-result" data-action="pick-part" data-code="' + esc(p.part_code) + '">' +
            '<b>' + esc(p.part_code) + '</b> ' + esc(p.label) + ' <span class="muted">(' + esc(sys ? sys.label : "") + ')</span></button>';
        }).join("") : '<p class="muted" style="padding:10px">검색 결과 없음 — 코드가 없으면 ‘원인 미확정’으로 종결하세요.</p>') +
        '</div>';
    }

    var aiRefs = [];
    if (issue.ai_analysis) {
      (issue.ai_analysis.similar_cases || []).forEach(function (c) { aiRefs.push(c.case_id); });
      (issue.ai_analysis.related_documents || []).forEach(function (d) { aiRefs.push(d.doc_id); });
    }
    aiRefs.push("전문가 경험");
    var refChecks = aiRefs.map(function (r) {
      return '<label class="check-row"><input type="checkbox" class="rationale-check" data-ref="' + esc(r) + '"' + (f.refs[r] ? " checked" : "") + '> ' + esc(r) + '</label>';
    }).join("");

    var reasons = S.undetermined.reasons.map(function (r) {
      return '<option value="' + esc(r.code) + '"' + (f.reason === r.code ? " selected" : "") + '>' + esc(r.label) + '</option>';
    }).join("");

    return '' +
      '<section class="card" id="opinion-section"><h3>구조화 결론 입력 <span class="sr">(E-04 · 자유 서술 → AI 4필드 초안 → 확정)</span></h3>' +
      '<label class="fld" for="expert-free-text">자유 서술 (음성 대신 텍스트, DP-6)</label>' +
      '<textarea id="expert-free-text" placeholder="예) 유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다. 예열 후 재현 확인하고 미재현 시 정상 판정하면 됩니다. 동절기 예열 절차 안내가 필요합니다.">' + esc(f.free_text) + '</textarea>' +
      '<button class="ghost" id="btn-ai-draft" data-action="ai-draft" style="margin-top:10px;width:100%">AI 초안 생성</button>' +

      '<h3>① 확정 원인 <span class="sr">*필수 · 계통/부품 코드 마스터 선택(자유 텍스트 금지)</span></h3>' +
      '<input type="text" id="part-search" placeholder="🔍 부품/계통 검색 (예: 선회, 릴리프, SW-HYD)" value="' + esc(state.partQuery) + '">' +
      results +
      (selectedPart
        ? '<div><span class="code-chip" id="selected-part-code">' + esc(selectedPart.part_code) + '</span> ' +
          '<span id="selected-part-label">' + esc(selectedSystem.label) + ' / ' + esc(selectedPart.label) + '</span></div>'
        : '<p class="muted" style="margin-top:6px">선택된 코드 없음</p>') +
      '<label class="check-row" style="margin-top:8px"><input type="checkbox" id="chk-undetermined"' + (f.undetermined ? " checked" : "") + '> 원인 미확정으로 종결</label>' +
      '<select id="undetermined-reason"' + (f.undetermined ? "" : " disabled") + '><option value="">사유 선택 *필수</option>' + reasons + '</select>' +

      '<h3>② 조치 내용 <span class="sr">*필수</span></h3>' +
      '<select id="action-type"><option value="">조치 유형 선택</option>' +
      ["점검", "조정", "부품교체", "안내"].map(function (t) {
        return '<option value="' + t + '"' + (f.action_type === t ? " selected" : "") + '>' + t + '</option>';
      }).join("") + '</select>' +
      '<input type="text" id="action-detail" placeholder="조치 내용" value="' + esc(f.action_detail) + '" style="margin-top:8px">' +

      '<h3>③ 판단 근거 <span class="sr">*필수(1개 이상 체크)</span></h3>' +
      refChecks +
      '<input type="text" id="rationale-text" placeholder="보충 서술 (예: 냉간 시 선회 압력 순간 상승으로 판단)" value="' + esc(f.rationale_text) + '">' +

      '<h3>④ 재발 방지 <span class="sr">선택</span></h3>' +
      '<input type="text" id="prevention" placeholder="예: 동절기 예열 절차 안내" value="' + esc(f.prevention) + '">' +

      '<button class="primary" id="btn-finalize" data-action="finalize-opinion">결론 확정</button>' +
      '</section>';
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

      /* E-02 근거 점프 */
      case "jump":
        state.hl = {
          input_id: el.getAttribute("data-input"),
          start: parseInt(el.getAttribute("data-start"), 10),
          end: parseInt(el.getAttribute("data-end"), 10)
        };
        syncOpinionForm();
        break;

      /* E-03 AI 분석 */
      case "run-ai": {
        var sc = scenarioOf(issue);
        var gg = E.gap.analyze(MNT, sc, issue.collected);
        issue.ai_analysis = adapter.analyzeIssue({
          collected: issue.collected,
          sufficiency: gg.sufficiency,
          expertChecks: issue.expert_checks,
          equipment: issue.equipment_ref
        });
        E.statemachine.appendAudit(issue, "ai_analysis",
          { verdict: issue.ai_analysis.verdict, confidence: issue.ai_analysis.confidence }, "mock-ai");
        Store.save(db);
        break;
      }
      case "request-field": {
        var items = (issue.ai_analysis.missing_info || []).slice();
        issue.pending_request = { items: items, requested_at: now(), reply: null };
        E.statemachine.transition(issue, "PENDING_FIELD", { actor: "전문가", note: "고객 추가 확인 요청" });
        notify(issue, "현장에서 확인이 필요한 항목이 있습니다");
        Store.save(db);
        break;
      }

      /* E-04 */
      case "ai-draft": {
        syncOpinionForm();
        var free = state.opinionForm.free_text.trim();
        if (!free) { alert("자유 서술을 먼저 입력해 주세요."); return; }
        var draft2 = adapter.draftStructuredOpinion(free);
        var f2 = state.opinionForm;
        f2.part_code = draft2.cause_part_code || f2.part_code;
        f2.action_type = draft2.action_type || f2.action_type;
        f2.action_detail = draft2.action_detail || f2.action_detail;
        f2.rationale_text = draft2.rationale_text || f2.rationale_text;
        f2.prevention = draft2.prevention || f2.prevention;
        f2.undetermined = draft2.cause_undetermined && !f2.part_code;
        state.partQuery = "";
        E.statemachine.appendAudit(issue, "ai_opinion_draft",
          { part_code: draft2.cause_part_code, action_type: draft2.action_type }, "mock-ai");
        Store.save(db);
        break;
      }
      case "pick-part": {
        syncOpinionForm();
        state.opinionForm.part_code = el.getAttribute("data-code");
        state.opinionForm.undetermined = false;
        state.partQuery = "";
        break;
      }
      case "finalize-opinion": {
        syncOpinionForm();
        var f3 = state.opinionForm;
        var refs = Object.keys(f3.refs);
        if (!f3.undetermined && !f3.part_code) { alert("확정 원인: 부품 코드를 선택하거나 '원인 미확정'을 체크하세요."); return; }
        if (f3.undetermined && !f3.reason) { alert("원인 미확정 사유 코드를 선택하세요."); return; }
        if (!f3.action_type || !f3.action_detail.trim()) { alert("조치 유형과 조치 내용을 입력하세요."); return; }
        if (refs.length === 0) { alert("판단 근거를 1개 이상 체크하세요."); return; }
        var part3 = f3.part_code ? S.parts.parts.filter(function (p) { return p.part_code === f3.part_code; })[0] : null;
        var sys3 = part3 ? S.parts.systems.filter(function (s) { return s.system_code === part3.system_code; })[0] : null;
        var reason3 = S.undetermined.reasons.filter(function (r) { return r.code === f3.reason; })[0];
        issue.expert_opinion = {
          original_text: f3.free_text,               // 전문가 원본(자유 서술) — 불변 보존(DP-1)
          cause_system_code: sys3 ? sys3.system_code : null,
          cause_system_label: sys3 ? sys3.label : null,
          cause_part_code: f3.undetermined ? null : f3.part_code,
          cause_part_label: part3 && !f3.undetermined ? part3.label : null,
          cause_undetermined: f3.undetermined,
          cause_undetermined_reason: f3.undetermined ? f3.reason : null,
          cause_undetermined_reason_label: f3.undetermined && reason3 ? reason3.label : null,
          action_type: f3.action_type,
          action_detail: f3.action_detail.trim(),
          rationale_refs: refs,
          rationale_text: f3.rationale_text.trim(),
          prevention: f3.prevention.trim(),
          finalized_at: now()
        };
        E.statemachine.appendAudit(issue, "expert_opinion_finalized", {
          part_code: issue.expert_opinion.cause_part_code,
          undetermined: issue.expert_opinion.cause_undetermined,
          action_type: issue.expert_opinion.action_type
        }, "전문가");
        state.opinionForm = null;
        state.rewriteText = null;
        Store.save(db);
        break;
      }

      /* E-05 승인 후 발송 */
      case "approve-send": {
        var rewriteEl = document.getElementById("customer-rewrite");
        var simplified = rewriteEl ? rewriteEl.value.trim() : state.rewriteText;
        var tech5 = issue.expert_opinion.original_text || issue.expert_opinion.rationale_text || "";
        issue.customer_response = {
          technical_original: tech5,      // 전문가 원본은 덮어쓰지 않는다 — 별도 저장(DP-1)
          simplified_response: simplified,
          approved_by: USER.name + "(전문가)",
          approved_at: now(),
          delivered_at: now(),
          delivery_status: "delivered"
        };
        E.statemachine.appendAudit(issue, "customer_response_approved", { by: USER.name }, "전문가");
        E.statemachine.transition(issue, "ANSWERED", { actor: "전문가", note: "승인 후 발송" });
        notify(issue, "전문가 답변이 도착했습니다 — 해결 여부를 알려주세요");
        state.rewriteText = null;
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
