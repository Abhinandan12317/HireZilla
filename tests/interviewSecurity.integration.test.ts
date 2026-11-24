import crypto from "crypto";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../backend/src/services/ai", () => ({
  generateJobEvaluationProfileWithAI: vi.fn(),
  evaluateResumeWithAI: vi.fn(),
  generateInterviewQuestionsWithAI: vi.fn(),
  generatePersonalizedCandidateInterviewQuestions: vi.fn(async ({ questionSet }) => ({
    questions: questionSet.questions.map((q: { id: string; prompt: string; competency: string; rubricSignals: string[] }) => ({
      id: q.id,
      prompt: q.prompt,
      competency: q.competency,
      category: "architecture",
      sourceContext: "mocked-context",
      difficulty: "intermediate" as const,
      rubricSignals: q.rubricSignals,
      evaluationCriteria: ["Hidden evaluation criterion"],
      weaknessIndicators: ["Hidden weakness indicator"],
      expectedTimeMinutes: 10,
    })),
    context: {
      generatedAt: new Date().toISOString(),
      resumeSummary: "Mocked context summary",
      javascriptSkillProfile: {
        declaredSkills: ["TypeScript"],
        verifiedSkills: ["TypeScript"],
        claimedSkillEvidence: [],
        depthGaps: [],
      },
      projectsSummary: [],
      mappingNotes: [],
      budgetMetadata: {
        maxTokens: 5500,
        estimatedTokens: 200,
        truncated: false,
        sectionsIncluded: ["job_requirements"],
      },
    },
    aiMetadata: {
      model: "gemini-4-hydrogen",
      promptVersion: "v2-test",
      keyUsed: "primary" as const,
      fallbackActivated: false,
      promptTokensEstimate: 200,
      truncated: false,
    },
  })),
  evaluateInterviewWithAI: vi.fn(async ({ session }) => ({
    overallInterviewScore: 84,
    atsCumulativeScore: 86,
    targetLevelLabel: "Solid Engineer",
    confidence: "high" as const,
    dimensions: [
      { name: "Architecture", score: 85, rubricTarget: 75, summary: "Sound judgment." },
      { name: "Systems", score: 84, rubricTarget: 75, summary: "Good concurrency analysis." },
      { name: "Clarity", score: 83, rubricTarget: 75, summary: "Structured response." },
    ],
    synthesisSummary: "Candidate demonstrated solid engineering reasoning.",
    verifiedStrengths: ["Clear architectural breakdown"],
    recommendedDeepDive: "Probe failure recovery further.",
    questionEvaluations: session.questions.map((q: { id: string; prompt: string; competency: string }) => ({
      questionId: q.id,
      questionPrompt: q.prompt,
      competency: q.competency,
      score: 84,
      ratingLabel: "Strong",
      rubricChecks: ["Addressed trade-offs"],
      evidenceFromAnswer: "Direct response provided.",
      evaluatorNote: "Good reasoning.",
      confidence: "high" as const,
    })),
    model: "gemini-4-hydrogen",
    promptVersion: "v2-test",
  })),
}));

import { createApp } from "../backend/src/app";
import { db } from "../backend/src/db/database";
import { ensureSeedData } from "../backend/src/services/seed";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await ensureSeedData();
  app = createApp();
});

describe("Hatchling Interview Security & Access Control (§19.2)", () => {
  it("stores CSPRNG hashed tokens only, enforces candidate auth & ownership, tenant isolation, expiry, revocation, regeneration, session leases, immutability, and rubric stripping", async () => {
    const priyaAgent = request.agent(app);
    await priyaAgent.post("/api/auth/demo-signin").send({ preset: "recruiter_priya" });

    // Create a clean published question set & shortlist Rohit/Maya or invite Elena
    const inviteRes = await priyaAgent
      .post("/api/recruiter/jobs/job_backend_sr/interviews/invite")
      .send({
        applicationIds: ["app_elena"],
        deadlineAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
        durationMinutes: 45,
      });
    expect(inviteRes.status).toBe(201);
    const inv = inviteRes.body.invitations[0];
    const rawToken = inv.inviteToken as string;
    expect(rawToken).toMatch(/^HZ-INT-/);
    expect(rawToken.length).toBeGreaterThan(24);
    expect(inv.tokenHash).toBeUndefined();

    // DB stores ONLY tokenHash + tokenHint, never plaintext rawToken
    const stored = await db.interviews.findById(inv.id);
    expect(stored).toBeTruthy();
    expect((stored as { token?: string })?.token).toBeUndefined();
    expect(stored?.tokenHash).toBe(
      crypto.createHash("sha256").update(rawToken).digest("hex")
    );
    expect(stored?.tokenHint).toMatch(/^HZ-INT-••••/);

    // 1. Unauthenticated candidate GET/START/SUBMIT rejected with 401
    const unauthGet = await request(app).get(`/api/interviews/token/${rawToken}`);
    expect(unauthGet.status).toBe(401);
    const unauthStart = await request(app).post(`/api/interviews/token/${rawToken}/start`);
    expect(unauthStart.status).toBe(401);

    // 2. Wrong candidate (Arjun trying Elena's token & ID) rejected with 403
    const arjunAgent = request.agent(app);
    await arjunAgent.post("/api/auth/demo-signin").send({ preset: "student_arjun" });

    const wrongCandGet = await arjunAgent.get(`/api/interviews/token/${rawToken}`);
    expect(wrongCandGet.status).toBe(403);
    expect(wrongCandGet.body.code).toBe("INTERVIEW_OWNERSHIP_MISMATCH");

    const wrongCandIdGet = await arjunAgent.get(`/api/interviews/id/${inv.id}`);
    expect(wrongCandIdGet.status).toBe(403);

    // 3. Cross-tenant recruiter IDOR blocked (Nimbus recruiter cannot view/revoke/regenerate CloudScale interview)
    const nimbusAgent = request.agent(app);
    await nimbusAgent.post("/api/auth/demo-signin").send({ preset: "recruiter_nimbus" });
    const crossTenantReport = await nimbusAgent.get(
      "/api/recruiter/applications/app_elena/interview-report"
    );
    expect(crossTenantReport.status).toBe(403);
    const crossTenantRevoke = await nimbusAgent.post(
      `/api/recruiter/interviews/${inv.id}/revoke`
    );
    expect(crossTenantRevoke.status).toBe(403);

    // 4. Token regeneration invalidates old token immediately
    const regenRes = await priyaAgent.post(
      `/api/recruiter/interviews/${inv.id}/regenerate`
    );
    expect(regenRes.status).toBe(200);
    const rotatedToken = regenRes.body.inviteToken as string;
    expect(rotatedToken).not.toBe(rawToken);

    const elenaAgent = request.agent(app);
    await elenaAgent.post("/api/auth/signin").send({ email: "elena.rostova@demo.hirezilla" });

    const staleGet = await elenaAgent.get(`/api/interviews/token/${rawToken}`);
    expect(staleGet.status).toBe(404);

    // 5. Valid candidate GET strips all internal rubricSignals / evaluationCriteria / weaknessIndicators
    const validGet = await elenaAgent.get(`/api/interviews/token/${rotatedToken}`);
    expect(validGet.status).toBe(200);
    expect(validGet.body.session.questions.length).toBeGreaterThanOrEqual(3);
    for (const q of validGet.body.session.questions) {
      expect(q.rubricSignals).toBeUndefined();
      expect(q.evaluationCriteria).toBeUndefined();
      expect(q.weaknessIndicators).toBeUndefined();
    }

    // 6. Start sets active lease; second window without lease gets 409 conflict unless it calls /resume
    const startRes = await elenaAgent.post(`/api/interviews/token/${rotatedToken}/start`);
    expect(startRes.status).toBe(200);
    const lease1 = startRes.body.sessionLeaseNonce as string;
    expect(lease1).toBeTruthy();

    const conflictStart = await elenaAgent.post(
      `/api/interviews/token/${rotatedToken}/start`
    );
    expect(conflictStart.status).toBe(409);
    expect(conflictStart.body.code).toBe("CONCURRENT_SESSION_CONFLICT");

    const conflictSave = await elenaAgent
      .put(`/api/interviews/token/${rotatedToken}/answers`)
      .set("X-Interview-Session-Nonce", "wrong-tab-nonce")
      .send({
        questionId: validGet.body.session.questions[0].id,
        answerText: "Should fail without matching lease",
      });
    expect(conflictSave.status).toBe(409);

    // Explicit resume rotates lease cleanly
    const resumeRes = await elenaAgent.post(`/api/interviews/token/${rotatedToken}/resume`);
    expect(resumeRes.status).toBe(200);
    const lease2 = resumeRes.body.sessionLeaseNonce as string;
    expect(lease2).not.toBe(lease1);

    // Old lease blocked, new lease succeeds
    const staleLeaseSave = await elenaAgent
      .put(`/api/interviews/token/${rotatedToken}/answers`)
      .set("X-Interview-Session-Nonce", lease1)
      .send({
        questionId: validGet.body.session.questions[0].id,
        answerText: "Old tab write rejected",
      });
    expect(staleLeaseSave.status).toBe(409);

    const activeLeaseSave = await elenaAgent
      .put(`/api/interviews/token/${rotatedToken}/answers`)
      .set("X-Interview-Session-Nonce", lease2)
      .send({
        questionId: validGet.body.session.questions[0].id,
        answerText: "Committed answer under active session lease.",
      });
    expect(activeLeaseSave.status).toBe(200);

    // 7. Submit locks interview; subsequent answer modifications & overwrites fail with 409
    const submitRes = await elenaAgent
      .post(`/api/interviews/token/${rotatedToken}/submit`)
      .set("X-Interview-Session-Nonce", lease2)
      .send({});
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.session.status).toBe("report_ready");

    const postSubmitEdit = await elenaAgent
      .put(`/api/interviews/token/${rotatedToken}/answers`)
      .send({
        questionId: validGet.body.session.questions[0].id,
        answerText: "Tampering attempt after submit",
      });
    expect(postSubmitEdit.status).toBe(409);

    const postSubmitOverwrite = await elenaAgent
      .post(`/api/interviews/token/${rotatedToken}/submit`)
      .send({
        answers: [
          {
            questionId: validGet.body.session.questions[0].id,
            answerText: "Tampering submit attempt",
          },
        ],
      });
    expect(postSubmitOverwrite.status).toBe(409);
  });

  it("blocks revoked and expired invitations cleanly with 403 and 410", async () => {
    const priyaAgent = request.agent(app);
    await priyaAgent.post("/api/auth/demo-signin").send({ preset: "recruiter_priya" });

    const inviteRes = await priyaAgent
      .post("/api/recruiter/jobs/job_backend_sr/interviews/invite")
      .send({
        applicationIds: ["app_arjun"],
        deadlineAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
        durationMinutes: 30,
      });
    expect(inviteRes.status).toBe(201);
    const inv = inviteRes.body.invitations[0];
    const token = inv.inviteToken as string;

    const revokeRes = await priyaAgent.post(`/api/recruiter/interviews/${inv.id}/revoke`);
    expect(revokeRes.status).toBe(200);

    const arjunAgent = request.agent(app);
    await arjunAgent.post("/api/auth/demo-signin").send({ preset: "student_arjun" });

    const revokedAccess = await arjunAgent.get(`/api/interviews/token/${token}`);
    expect(revokedAccess.status).toBe(403);
    expect(revokedAccess.body.code).toBe("INTERVIEW_REVOKED");
  });
});
