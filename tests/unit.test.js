/**
 * 단위 테스트 — 실행: node tests/unit.test.js
 *
 * 대상: DecisionImpact 계산(수기 검증), confidence 출처 테이블, 상태머신 전이/불법 전이,
 *       Intent/안전 감지, Gap 분석(15장 시나리오 원문), 질문 3개 제한·획득가능성 '하' 제외,
 *       Mock AI(A/B/C/D, 4필드 초안, 고객 언어 변환), 스키마 번들 동기화.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const domainsSchema = readJSON("schema/domains.json");
const mntSchema = readJSON("schema/maintenance.requirements.json");
const partsMaster = readJSON("schema/parts.master.json");
const undetermined = readJSON("schema/undetermined_reasons.json");

const confidence = require("../engine/confidence.js");
const intent = require("../engine/intent.js");
const gap = require("../engine/gap.js");
const question = require("../engine/question.js");
const sm = require("../engine/statemachine.js");
const mockai = require("../engine/mockai.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✔ " + name);
  } catch (e) {
    failed++;
    console.error("  ✘ " + name);
    console.error("    " + (e && e.message));
  }
}

const SEED_TEXT = "붐을 내리고 오른쪽으로 돌면 가끔 덜컹거립니다.";
const reqById = {};
mntSchema.requirements.forEach((r) => { reqById[r.requirement_id] = r; });

console.log("\n[1] DecisionImpact = 판별력 × 획득가능성 × 미확보도 (수기 검증)");
test("MNT-04 재현성(5, 상, 미확보) = 5 × 1.0 × 1 = 5.0", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-04"], "uncovered", mntSchema), 5.0);
});
test("MNT-07 RPM(4, 중, 미확보) = 4 × 0.6 × 1 = 2.4", () => {
  assert.ok(Math.abs(question.decisionImpact(reqById["MNT-07"], "uncovered", mntSchema) - 2.4) < 1e-9);
});
test("MNT-06 빈도(3, 상, 부분 확보) = 3 × 1.0 × 0.5 = 1.5", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-06"], "partial", mntSchema), 1.5);
});
test("MNT-10 유압 온도(3, 하, 미확보) = 3 × 0.1 × 1 = 0.3", () => {
  assert.ok(Math.abs(question.decisionImpact(reqById["MNT-10"], "uncovered", mntSchema) - 0.3) < 1e-9);
});
test("MNT-12 장비 식별(5, 자동) = 5 × 0 × 1 = 0 (질문 예산 미소모)", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-12"], "uncovered", mntSchema), 0);
});
test("확보 완료 항목의 미확보도 = 0 → impact 0", () => {
  assert.strictEqual(question.decisionImpact(reqById["MNT-04"], "covered", mntSchema), 0);
});

console.log("\n[2] 출처 기반 confidence 테이블 (원문 9.2 그대로)");
test("uttered 0.95 / answered 0.99 / system 1.0 / inferred 0.6 / default 0.4 / ambiguous 0.5", () => {
  assert.strictEqual(confidence.confidenceFor("uttered"), 0.95);
  assert.strictEqual(confidence.confidenceFor("answered"), 0.99);
  assert.strictEqual(confidence.confidenceFor("system"), 1.0);
  assert.strictEqual(confidence.confidenceFor("inferred"), 0.6);
  assert.strictEqual(confidence.confidenceFor("default"), 0.4);
  assert.strictEqual(confidence.confidenceFor("ambiguous"), 0.5);
});
test("confidence < 0.7 필드만, 판단영향도 순 상위 2개만 확인 대상(DP-4)", () => {
  const collected = [
    { requirement_id: "MNT-01", value_state: "known", confidence: 0.95 }, // 확인 제외
    { requirement_id: "MNT-06", value_state: "known", confidence: 0.6 },  // 3.0
    { requirement_id: "MNT-08", value_state: "known", confidence: 0.4 },  // 2.4
    { requirement_id: "MNT-03", value_state: "known", confidence: 0.5 },  // 5.0
    { requirement_id: "MNT-07", value_state: "unknown", confidence: 0.6 } // known 아님 → 제외
  ];
  const targets = confidence.confirmTargets(collected, mntSchema);
  assert.strictEqual(targets.length, 2);
  assert.deepStrictEqual(targets.map((t) => t.requirement_id), ["MNT-03", "MNT-06"]);
});

console.log("\n[3] Issue 상태머신 — 정상 루프와 불법 전이");
test("전체 루프 1회전: DRAFT→…→RESOLVED→KNOWLEDGE_READY", () => {
  const issue = { status: "DRAFT", audit: [] };
  ["SUBMITTED", "ASSIGNED", "IN_REVIEW", "PENDING_FIELD", "IN_REVIEW", "ANSWERED", "RESOLVED", "KNOWLEDGE_READY"]
    .forEach((s) => sm.transition(issue, s, { actor: "test" }));
  assert.strictEqual(issue.status, "KNOWLEDGE_READY");
  assert.strictEqual(issue.audit.length, 8); // FR-25 append-only
  assert.strictEqual(issue.audit[0].detail.from, "DRAFT");
});
test("REOPEN 루프: ANSWERED→REOPENED→IN_REVIEW", () => {
  const issue = { status: "ANSWERED", audit: [] };
  sm.transition(issue, "REOPENED");
  sm.transition(issue, "IN_REVIEW");
  assert.strictEqual(issue.status, "IN_REVIEW");
});
test("불법 전이는 throw: DRAFT→ANSWERED, RESOLVED→REOPENED, SUBMITTED→IN_REVIEW", () => {
  assert.throws(() => sm.transition({ status: "DRAFT", audit: [] }, "ANSWERED"), /불법 상태 전이/);
  assert.throws(() => sm.transition({ status: "RESOLVED", audit: [] }, "REOPENED"), /불법 상태 전이/);
  assert.throws(() => sm.transition({ status: "SUBMITTED", audit: [] }, "IN_REVIEW"), /불법 상태 전이/);
});
test("어느 단계에서든 MERGED/STALE/CLOSED_UNVERIFIED 진입 가능(DP-9)", () => {
  ["DRAFT", "IN_REVIEW", "ANSWERED", "PENDING_FIELD"].forEach((from) => {
    ["MERGED", "STALE", "CLOSED_UNVERIFIED"].forEach((to) => {
      assert.ok(sm.canTransition(from, to), from + "→" + to);
    });
  });
  assert.ok(!sm.canTransition("MERGED", "STALE"));
});

console.log("\n[4] Intent 분류 + 안전 위험 감지 (FR-04/05)");
test("시나리오 원문 → 정비 도메인 / abnormal_symptom", () => {
  const r = intent.classify(SEED_TEXT, domainsSchema);
  assert.strictEqual(r.domain, "maintenance");
  assert.strictEqual(r.intent, "abnormal_symptom");
  assert.strictEqual(r.safety_flag, false);
});
test("경고등 문구 → warning_lamp Intent", () => {
  const r = intent.classify("주행 중에 경고등이 켜졌어요", domainsSchema);
  assert.strictEqual(r.domain, "maintenance");
  assert.strictEqual(r.intent, "warning_lamp");
});
test("안전 위험 키워드(연기/브레이크 안 들음) → safety_flag=true", () => {
  const r = intent.classify("엔진룸에서 연기가 나고 브레이크가 안 들어요", domainsSchema);
  assert.strictEqual(r.safety_flag, true);
  assert.ok(r.safety_hits.length >= 2);
});
test("매칭 없는 입력 → 기타(etc)", () => {
  const r = intent.classify("안녕하세요", domainsSchema);
  assert.strictEqual(r.domain, "etc");
});

console.log("\n[5] Gap 분석 — 15장 Step 2 재현");
test("시나리오 선택: 기본=이상 현상(MNT-S01), 경고등 입력=MNT-S02 (동적 정보요건)", () => {
  assert.strictEqual(gap.pickScenario(SEED_TEXT, mntSchema).scenario_id, "MNT-S01");
  assert.strictEqual(gap.pickScenario("경고등이 켜졌어요", mntSchema).scenario_id, "MNT-S02");
});
const scenario = gap.pickScenario(SEED_TEXT, mntSchema);
const extracted = gap.extract(SEED_TEXT, mntSchema, scenario, "input-1");
test("확보: 현상=충격 ✓, 작업=선회 ✓, 조건=붐 하강+우선회 ✓, 빈도=△(부분)", () => {
  const byId = {};
  extracted.forEach((c) => { byId[c.requirement_id] = c; });
  assert.strictEqual(byId["MNT-01"].value, "충격");
  assert.strictEqual(byId["MNT-02"].value, "선회");
  assert.strictEqual(byId["MNT-03"].value, "붐 하강 + 우선회");
  assert.strictEqual(byId["MNT-06"].coverage, "partial");
  assert.strictEqual(byId["MNT-06"].source_type, "inferred");
  assert.strictEqual(byId["MNT-06"].confidence, 0.6);
  assert.ok(!byId["MNT-04"] && !byId["MNT-05"] && !byId["MNT-08"], "재현성/예열/정비이력은 미확보");
});
test("evidence_ref: input_id + 원문 char offset(DP-2)", () => {
  extracted.forEach((c) => {
    assert.strictEqual(c.evidence_ref.input_id, "input-1");
    assert.strictEqual(SEED_TEXT.slice(c.evidence_ref.start, c.evidence_ref.end), c.evidence_ref.matched_text);
  });
  const symptom = extracted.filter((c) => c.requirement_id === "MNT-01")[0];
  assert.strictEqual(symptom.evidence_ref.matched_text, "덜컹");
});
test("Gap = 필요 − 확보, 정보충분도 계산", () => {
  const g = gap.analyze(mntSchema, scenario, extracted);
  const gapIds = g.gap.map((r) => r.requirement_id);
  ["MNT-04", "MNT-05", "MNT-06", "MNT-07", "MNT-08", "MNT-10", "MNT-11", "MNT-12"].forEach((id) => {
    assert.ok(gapIds.indexOf(id) >= 0, id + " 은 Gap");
  });
  assert.ok(g.sufficiency > 0 && g.sufficiency < 1);
});

console.log("\n[6] Question Engine — 3개 제한 · '하' 제외 · [모르겠음] (P1~P5)");
const questions = question.generateQuestions(mntSchema, scenario, extracted);
test("상위 3개 = 재현성 · 예열 상태 · 최근 정비 이력 (Step 2와 동일)", () => {
  assert.strictEqual(questions.length, 3);
  assert.deepStrictEqual(questions.map((q) => q.requirement_id), ["MNT-04", "MNT-05", "MNT-08"]);
});
test("모든 질문에 [모르겠음] 포함 (P4)", () => {
  questions.forEach((q) => assert.ok(q.options.indexOf("모르겠음") >= 0, q.requirement_id));
});
test("획득가능성 '하'(MNT-10/11)와 자동(MNT-12)은 절대 질문하지 않음 (P5)", () => {
  const all = question.generateQuestions(mntSchema, scenario, [], 99);
  const ids = all.map((q) => q.requirement_id);
  assert.ok(ids.indexOf("MNT-10") < 0 && ids.indexOf("MNT-11") < 0 && ids.indexOf("MNT-12") < 0);
});
test("MNT-10/11 은 전문가 추가 확인 항목으로 반환", () => {
  const checks = question.expertCheckItems(mntSchema, scenario, extracted);
  assert.deepStrictEqual(checks.map((c) => c.requirement_id), ["MNT-10", "MNT-11"]);
  assert.deepStrictEqual(checks.map((c) => c.label), ["유압 온도", "선회 압력"]);
});
test("unknown/skipped 응답 항목은 재질문하지 않음", () => {
  const withUnknown = extracted.concat([
    { requirement_id: "MNT-04", value_state: "unknown", value: null },
    { requirement_id: "MNT-05", value_state: "skipped", value: null }
  ]);
  const qs = question.generateQuestions(mntSchema, scenario, withUnknown);
  const ids = qs.map((q) => q.requirement_id);
  assert.ok(ids.indexOf("MNT-04") < 0 && ids.indexOf("MNT-05") < 0);
});

console.log("\n[7] Mock AI — A/B/C/D 판정 · 4필드 초안 · 고객 언어 변환");
const adapter = mockai.createMockAdapter(partsMaster);
test("시나리오 이슈(선회+충격, 답변 완료) → 판정 B, Case #0832 87%, Manual 4-2", () => {
  const answered = extracted.concat([
    { requirement_id: "MNT-04", value: "가끔", value_state: "known", coverage: "full", source_type: "answered", confidence: 0.99 },
    { requirement_id: "MNT-05", value: "시동 직후", value_state: "known", coverage: "full", source_type: "answered", confidence: 0.99 },
    { requirement_id: "MNT-08", value: "없음", value_state: "known", coverage: "full", source_type: "answered", confidence: 0.99 },
    { requirement_id: "MNT-12", value: "HX220A / SN 3421 / 3,410h", value_state: "known", coverage: "full", source_type: "system", confidence: 1.0 }
  ]);
  const g = gap.analyze(mntSchema, scenario, answered);
  const checks = question.expertCheckItems(mntSchema, scenario, answered);
  const a = adapter.analyzeIssue({ collected: answered, sufficiency: g.sufficiency, expertChecks: checks });
  assert.strictEqual(a.verdict, "B");
  assert.strictEqual(a.similar_cases[0].case_id, "Case #0832");
  assert.strictEqual(a.similar_cases[0].similarity, 0.87);
  assert.strictEqual(a.related_documents[0].doc_id, "Manual 4-2");
  assert.ok(a.limitations.indexOf("유압 온도") >= 0 && a.limitations.indexOf("선회 압력") >= 0, "한계 명시");
});
test("정보충분도 낮음 → 판정 D + 추가 필요 정보 목록", () => {
  const a = adapter.analyzeIssue({ collected: [], sufficiency: 0.2, expertChecks: [] });
  assert.strictEqual(a.verdict, "D");
  assert.ok(a.missing_info.length > 0);
});
test("경고등 있음 → 판정 A / 무관 입력 → 판정 C(자료 없음 명시, DP-5)", () => {
  const a = adapter.analyzeIssue({
    collected: [{ requirement_id: "MNT-09", value: "있음(촬영)", value_state: "known" }],
    sufficiency: 0.8, expertChecks: []
  });
  assert.strictEqual(a.verdict, "A");
  const c = adapter.analyzeIssue({
    collected: [{ requirement_id: "MNT-01", value: "소음", value_state: "known" }],
    sufficiency: 0.8, expertChecks: []
  });
  assert.strictEqual(c.verdict, "C");
  assert.ok(c.recommendation.indexOf("찾지 못했습니다") >= 0);
});
test("전문가 자유 서술 → 4필드 초안 (SW-HYD-0412 매핑, 조치유형 '안내')", () => {
  const draft = adapter.draftStructuredOpinion(
    "유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다. " +
    "예열 후 재현 확인하고 미재현 시 정상 판정하면 됩니다. 동절기 예열 절차 안내가 필요합니다."
  );
  assert.strictEqual(draft.cause_part_code, "SW-HYD-0412");
  assert.strictEqual(draft.cause_system_code, "SW-HYD");
  assert.strictEqual(draft.cause_system_label, "선회 유압 계통");
  assert.strictEqual(draft.action_type, "안내");
  assert.ok(draft.rationale_text.indexOf("판단") >= 0);
  assert.ok(draft.action_detail.indexOf("재현 확인") >= 0);
  assert.ok(draft.prevention.indexOf("동절기") >= 0);
});
test("기술 언어 → 고객 언어 치환 템플릿 (원문 10.4 예시)", () => {
  const out = adapter.rewriteForCustomer(
    "유압 오일 온도가 낮은 상태에서 선회 압력이 순간적으로 상승해서 발생하는 현상으로 판단됩니다."
  );
  assert.ok(out.indexOf("장비가 충분히 예열되지 않은 상태") >= 0);
  assert.ok(out.indexOf("충격이 발생할 가능성") >= 0);
  assert.ok(out.indexOf("유압") < 0, "기술 용어 제거");
  assert.ok(out.indexOf("예열한 후") >= 0, "예열 안내 포함");
});

console.log("\n[8] 스키마 무결성 + 번들 동기화");
test("MNT-01~12 12개 요건, 원문 7.2 판별력/획득가능성 일치", () => {
  assert.strictEqual(mntSchema.requirements.length, 12);
  const expect = {
    "MNT-01": [5, "상"], "MNT-02": [4, "상"], "MNT-03": [5, "상"], "MNT-04": [5, "상"],
    "MNT-05": [5, "상"], "MNT-06": [3, "상"], "MNT-07": [4, "중"], "MNT-08": [4, "중"],
    "MNT-09": [4, "상"], "MNT-10": [3, "하"], "MNT-11": [4, "하"], "MNT-12": [5, "자동"]
  };
  Object.keys(expect).forEach((id) => {
    assert.strictEqual(reqById[id].discriminative_weight, expect[id][0], id + " 판별력");
    assert.strictEqual(reqById[id].obtainability, expect[id][1], id + " 획득가능성");
  });
});
test("부품 마스터: SW-HYD-0412 선회 모터 릴리프 밸브 / 선회 유압 계통 포함, 20개 이상", () => {
  const p = partsMaster.parts.filter((x) => x.part_code === "SW-HYD-0412")[0];
  assert.ok(p && p.label === "선회 모터 릴리프 밸브");
  const s = partsMaster.systems.filter((x) => x.system_code === p.system_code)[0];
  assert.strictEqual(s.label, "선회 유압 계통");
  assert.ok(partsMaster.parts.length >= 20);
});
test("미확정 사유 코드 4종(정보부족/재현불가/고객 미회신/타 부서 이관)", () => {
  assert.deepStrictEqual(undetermined.reasons.map((r) => r.label),
    ["정보부족", "재현불가", "고객 미회신", "타 부서 이관"]);
});
test("app/schema.bundle.js 가 schema/*.json 과 동기화되어 있음", () => {
  const src = fs.readFileSync(path.join(root, "app/schema.bundle.js"), "utf8");
  const sandbox = {};
  vm.runInNewContext(src + "\n;__out = JSON.stringify(this.FI_SCHEMA);", sandbox);
  const bundle = JSON.parse(sandbox.__out); // vm 컨텍스트 간 프로토타입 차이 제거
  assert.deepStrictEqual(bundle.domains, domainsSchema);
  assert.deepStrictEqual(bundle.maintenance, mntSchema);
  assert.deepStrictEqual(bundle.parts, partsMaster);
  assert.deepStrictEqual(bundle.undetermined, undetermined);
});

console.log("\n결과: " + passed + " 통과, " + failed + " 실패");
if (failed > 0) process.exit(1);
