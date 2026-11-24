import type {
  CandidateContextEvidenceItem,
  InterviewContextRecord,
  JobPosting,
  ResumeEvaluationRecord,
  ResumeFileRecord,
  StudentPortfolio,
} from "../../../shared/types";
import { config } from "../config";
import {
  budgetContextBlocks,
  estimateTokens,
  type PrioritizedContextBlock,
} from "./aiResilience";

const JS_KEYWORDS = [
  "javascript",
  "typescript",
  "js",
  "ts",
  "react",
  "next",
  "node",
  "express",
  "vue",
  "angular",
  "redux",
  "dom",
  "async",
  "promise",
  "event loop",
  "closure",
  "tailwind",
  "vite",
  "webpack",
  "vitest",
  "jest",
];

const INJECTION_LINE_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /system prompt/i,
  /reveal (the )?(api key|secret|password|rubric)/i,
  /give (me|this candidate) 100/i,
  /<\/?untrusted_candidate_data/i,
];

export function sanitizeUntrustedCandidateText(input: string | null | undefined, maxChars = 4000): string {
  if (!input) return "";
  const cleaned = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/<\/?untrusted_candidate_data[^>]*>/gi, "[redacted-tag]")
    .split(/\r?\n/)
    .map((line) => {
      if (INJECTION_LINE_PATTERNS.some((rx) => rx.test(line))) {
        return "[untrusted text ignored by security filter]";
      }
      return line;
    })
    .join("\n")
    .trim();

  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

export function wrapUntrustedCandidateData(source: string, content: string): string {
  return `<untrusted_candidate_data source="${source}">\n${sanitizeUntrustedCandidateText(
    content,
    6000
  )}\n</untrusted_candidate_data>`;
}

function extractResumeSignals(params: {
  resumeFile: ResumeFileRecord | null;
  resumeEvaluation: ResumeEvaluationRecord | null;
  job: JobPosting;
}): {
  hasResume: boolean;
  technicalSkills: string[];
  workExperienceSummaries: string[];
  educationSummary: string | null;
  unverifiedClaims: string[];
  evidenceExcerpts: string[];
} {
  const rawText = sanitizeUntrustedCandidateText(
    params.resumeFile?.extractedText || params.resumeFile?.pageAnnotatedText || "",
    9000
  );
  const evalItems = params.resumeEvaluation?.categoryEvaluations ?? [];

  if (!rawText && evalItems.length === 0) {
    return {
      hasResume: false,
      technicalSkills: [],
      workExperienceSummaries: [],
      educationSummary: null,
      unverifiedClaims: [],
      evidenceExcerpts: [],
    };
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && !/^\[Page \d+\]$/i.test(l));

  // Skills mentioned in resume text matched against job skills & common technical terms
  const lowerText = rawText.toLowerCase();
  const candidatePool = Array.from(
    new Set([
      ...params.job.requiredSkills,
      ...params.job.preferredSkills,
      "JavaScript",
      "TypeScript",
      "React",
      "Node.js",
      "Python",
      "FastAPI",
      "Go",
      "PostgreSQL",
      "MongoDB",
      "Redis",
      "Docker",
      "Kubernetes",
      "REST",
      "GraphQL",
      "gRPC",
      "AWS",
    ])
  );
  const technicalSkills = candidatePool.filter((skill) =>
    lowerText.includes(skill.toLowerCase())
  );

  const workLines = lines
    .filter((l) =>
      /\b(engineer|developer|intern|built|designed|implemented|led|experience|microservice|api|service|latency)\b/i.test(
        l
      )
    )
    .slice(0, 5);

  const eduLine =
    lines.find((l) =>
      /\b(b\.tech|b\.e\.|bachelor|master|m\.tech|b\.sc|university|institute|college|degree|computer science)\b/i.test(
        l
      )
    ) ?? null;

  const evalExcerpts = evalItems
    .flatMap((c) => c.evidence.map((e) => e.excerpt || e.description))
    .filter(Boolean)
    .slice(0, 6);

  const limitations = evalItems.flatMap((c) => c.limitations).filter(Boolean).slice(0, 4);
  const unverifiedClaims: string[] = [...limitations];

  // Flag listed skills that have no descriptive context line
  for (const skill of technicalSkills.slice(0, 6)) {
    const hasContext = lines.some(
      (l) => l.toLowerCase().includes(skill.toLowerCase()) && l.split(/\s+/).length >= 6
    );
    if (!hasContext) {
      unverifiedClaims.push(
        `Resume lists "${skill}" without concrete production or implementation specifics.`
      );
    }
  }

  return {
    hasResume: true,
    technicalSkills,
    workExperienceSummaries: workLines.length > 0 ? workLines : evalExcerpts.slice(0, 3),
    educationSummary: eduLine,
    unverifiedClaims: Array.from(new Set(unverifiedClaims)).slice(0, 5),
    evidenceExcerpts: evalExcerpts,
  };
}

function extractJavaScriptSkillProfile(params: {
  portfolio: StudentPortfolio | null;
  resumeSkills: string[];
}): InterviewContextRecord["javascriptSkillProfile"] & { hasData: boolean } {
  const skills = params.portfolio?.skills ?? [];
  const projects = params.portfolio?.projects ?? [];

  const jsPortfolioSkills = skills.filter((s) =>
    JS_KEYWORDS.some((kw) => s.name.toLowerCase().includes(kw))
  );

  const jsProjects = projects.filter((p) => {
    const blob = `${p.title} ${p.description} ${p.technologies.join(" ")}`.toLowerCase();
    return JS_KEYWORDS.some((kw) => blob.includes(kw));
  });

  const demonstratedConcepts: string[] = [];
  const claimedConcepts: string[] = [];
  const technicalStrengths: string[] = [];
  const potentialGaps: string[] = [];

  for (const s of jsPortfolioSkills) {
    const label = s.selfRating ? `${s.name} (self-rated: ${s.selfRating})` : s.name;
    const backedByProject = jsProjects.some((p) =>
      `${p.description} ${p.technologies.join(" ")}`
        .toLowerCase()
        .includes(s.name.toLowerCase())
    );
    if (backedByProject) {
      demonstratedConcepts.push(label);
      if (s.selfRating === "advanced") {
        technicalStrengths.push(`${s.name} applied across portfolio projects.`);
      }
    } else {
      claimedConcepts.push(label);
    }
  }

  for (const rs of params.resumeSkills) {
    if (JS_KEYWORDS.some((kw) => rs.toLowerCase().includes(kw))) {
      if (
        !demonstratedConcepts.some((d) => d.toLowerCase().includes(rs.toLowerCase())) &&
        !claimedConcepts.some((c) => c.toLowerCase().includes(rs.toLowerCase()))
      ) {
        claimedConcepts.push(`${rs} (resume claim)`);
      }
    }
  }

  if (jsPortfolioSkills.length === 0 && jsProjects.length === 0 && claimedConcepts.length === 0) {
    potentialGaps.push("No direct JavaScript/TypeScript proficiency evidence found in portfolio or resume.");
  } else if (demonstratedConcepts.length === 0 && claimedConcepts.length > 0) {
    potentialGaps.push("JavaScript/TypeScript skills are listed without mapped JS project implementation details.");
  }

  const hasData =
    demonstratedConcepts.length > 0 || claimedConcepts.length > 0 || jsProjects.length > 0;

  return {
    hasData,
    demonstratedConcepts,
    claimedConcepts,
    technicalStrengths,
    potentialGaps,
    confidenceNote: hasData
      ? "Derived strictly from portfolio skills, project technologies, and resume mentions without fabricating proficiency."
      : "No JavaScript profile data supplied; rely on available resume and non-JS project evidence.",
  };
}

function extractRelevantProjects(params: {
  portfolio: StudentPortfolio | null;
  job: JobPosting;
  targetCompetencies?: string[];
}): InterviewContextRecord["projectMappings"] {
  const projects = params.portfolio?.projects ?? [];
  if (projects.length === 0) return [];

  const jobKeywords = new Set(
    [
      ...params.job.requiredSkills,
      ...params.job.preferredSkills,
      ...(params.targetCompetencies ?? []),
      params.job.title,
    ]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((w) => w.length >= 2)
  );

  // Rank projects by overlap with job skills and detail richness (ignore low-value irrelevant clutter)
  const scored = projects.map((p) => {
    const desc = p.description || "";
    const role = p.roleContribution || "";
    const techs = p.technologies || [];
    const textBlob = `${p.title} ${desc} ${role} ${techs.join(" ")}`.toLowerCase();
    let score = 0;
    for (const kw of jobKeywords) {
      if (textBlob.includes(kw)) score += 3;
    }
    if (role.trim().length > 15) score += 2;
    if (desc.trim().length > 40) score += 2;
    return { project: p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Include max 4 most relevant projects
  return scored.slice(0, 4).map(({ project }) => ({
    title: sanitizeUntrustedCandidateText(project.title, 120),
    objective: sanitizeUntrustedCandidateText(project.description || "", 600),
    roleContribution: sanitizeUntrustedCandidateText(
      project.roleContribution || "Contribution details not explicitly specified.",
      350
    ),
    technologies: (project.technologies || []).slice(0, 12),
    repositoryUrl: project.githubUrl || project.projectUrl || null,
    repositoryFetched: false,
  }));
}

export function buildCandidateInterviewContext(params: {
  job: JobPosting;
  resumeFile: ResumeFileRecord | null;
  resumeEvaluation: ResumeEvaluationRecord | null;
  portfolio: StudentPortfolio | null;
  targetCompetencies?: string[];
  maxContextTokens?: number;
}): {
  context: InterviewContextRecord;
  promptBlocks: PrioritizedContextBlock[];
} {
  const maxContextTokens = params.maxContextTokens ?? config.aiMaxContextTokens;

  const resumeSignals = extractResumeSignals({
    resumeFile: params.resumeFile,
    resumeEvaluation: params.resumeEvaluation,
    job: params.job,
  });

  const jsProfile = extractJavaScriptSkillProfile({
    portfolio: params.portfolio,
    resumeSkills: resumeSignals.technicalSkills,
  });

  const projectMappings = extractRelevantProjects({
    portfolio: params.portfolio,
    job: params.job,
    targetCompetencies: params.targetCompetencies,
  });

  const evidenceItems: CandidateContextEvidenceItem[] = [];

  for (const exp of resumeSignals.workExperienceSummaries.slice(0, 4)) {
    evidenceItems.push({
      source: "resume",
      skillOrCompetency: resumeSignals.technicalSkills.slice(0, 3).join(", ") || "Experience",
      evidenceSummary: exp,
      projectAssociation: null,
      confidence: "medium",
      interviewOpportunity: "Probe concrete architecture decisions, ownership scope, and failure handling.",
    });
  }

  for (const claim of resumeSignals.unverifiedClaims.slice(0, 3)) {
    evidenceItems.push({
      source: "resume",
      skillOrCompetency: "Claim Verification",
      evidenceSummary: claim,
      projectAssociation: null,
      confidence: "low",
      interviewOpportunity: "Ask candidate to verify hands-on implementation depth rather than assuming mastery.",
    });
  }

  if (jsProfile.hasData) {
    evidenceItems.push({
      source: "javascript_skills",
      skillOrCompetency: "JavaScript / Frontend Engineering",
      evidenceSummary: [
        jsProfile.demonstratedConcepts.length > 0
          ? `Demonstrated: ${jsProfile.demonstratedConcepts.join(", ")}`
          : null,
        jsProfile.claimedConcepts.length > 0
          ? `Claimed: ${jsProfile.claimedConcepts.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" | "),
      projectAssociation: null,
      confidence: jsProfile.demonstratedConcepts.length > 0 ? "high" : "low",
      interviewOpportunity: "Assess practical async reasoning, state/event mechanics, and debugging judgment.",
    });
  }

  for (const proj of projectMappings) {
    evidenceItems.push({
      source: "project",
      skillOrCompetency: proj.technologies.slice(0, 4).join(", ") || "Project Architecture",
      evidenceSummary: `${proj.title}: ${proj.objective} (Contribution: ${proj.roleContribution})`,
      projectAssociation: proj.title,
      confidence: proj.roleContribution.length > 20 ? "high" : "medium",
      interviewOpportunity:
        "Probe trade-offs, candidate's exact individual contribution, edge cases, and scaling/debugging choices.",
    });
  }

  // Prioritize context strictly per §12.2:
  // 1. System & security (handled in reserved tokens)
  // 2. Job requirements & target competencies
  // 3. Relevant resume evidence
  // 4. JavaScript skill profile
  // 5. Relevant projects
  // 6. Additional portfolio context
  const candidateBlocks: PrioritizedContextBlock[] = [
    {
      id: "job_requirements",
      priority: 1,
      label: "Job Requirements & Target Competencies",
      text: JSON.stringify({
        jobTitle: params.job.title,
        experienceLevel: params.job.experienceLevel,
        requiredSkills: params.job.requiredSkills,
        preferredSkills: params.job.preferredSkills,
        targetCompetencies: params.targetCompetencies ?? [],
        summary: params.job.summary,
      }),
    },
    {
      id: "resume_evidence",
      priority: 2,
      label: "Source A: Resume Evidence (Untrusted Data)",
      text: resumeSignals.hasResume
        ? wrapUntrustedCandidateData(
            "resume",
            JSON.stringify({
              skills: resumeSignals.technicalSkills,
              workExperience: resumeSignals.workExperienceSummaries,
              education: resumeSignals.educationSummary,
              unverifiedClaims: resumeSignals.unverifiedClaims,
            })
          )
        : "Resume text unavailable.",
    },
    {
      id: "javascript_profile",
      priority: 3,
      label: "Source B: JavaScript Skill Profile (Untrusted Data)",
      text: jsProfile.hasData
        ? wrapUntrustedCandidateData(
            "javascript_skill_profile",
            JSON.stringify({
              demonstratedConcepts: jsProfile.demonstratedConcepts,
              claimedConcepts: jsProfile.claimedConcepts,
              technicalStrengths: jsProfile.technicalStrengths,
              potentialGaps: jsProfile.potentialGaps,
            })
          )
        : "No JavaScript profile entries supplied.",
    },
    ...projectMappings.map((proj, idx) => ({
      id: `project_${idx + 1}`,
      priority: 4 + idx,
      label: `Source C: Project ${idx + 1} (${proj.title})`,
      text: wrapUntrustedCandidateData(
        `project:${proj.title}`,
        JSON.stringify({
          title: proj.title,
          objective: proj.objective,
          roleContribution: proj.roleContribution,
          technologies: proj.technologies,
          repositoryUrl: proj.repositoryUrl,
          note: proj.repositoryUrl
            ? "Repository URL listed; source code has NOT been fetched or inspected."
            : undefined,
        })
      ),
    })),
  ];

  const budgeted = budgetContextBlocks({
    blocks: candidateBlocks,
    maxContextTokens,
    reservedSystemAndOutputTokens: Math.min(1800, Math.floor(maxContextTokens * 0.35)),
  });

  const context: InterviewContextRecord = {
    contextVersion: "ctx-v1",
    generatedAt: new Date().toISOString(),
    sourcesAvailable: {
      resume: resumeSignals.hasResume,
      javascriptProfile: jsProfile.hasData,
      projects: projectMappings.length > 0,
    },
    resumeHighlights: {
      technicalSkills: resumeSignals.technicalSkills,
      workExperienceSummaries: resumeSignals.workExperienceSummaries,
      educationSummary: resumeSignals.educationSummary,
      unverifiedClaims: resumeSignals.unverifiedClaims,
    },
    javascriptSkillProfile: {
      demonstratedConcepts: jsProfile.demonstratedConcepts,
      claimedConcepts: jsProfile.claimedConcepts,
      technicalStrengths: jsProfile.technicalStrengths,
      potentialGaps: jsProfile.potentialGaps,
      confidenceNote: jsProfile.confidenceNote,
    },
    projectMappings,
    evidenceItems,
    budgetMetadata: {
      maxContextTokens,
      estimatedTokensUsed: budgeted.estimatedTokensUsed,
      truncated: budgeted.truncated,
      omittedItemsCount: budgeted.omittedCount,
    },
  };

  return { context, promptBlocks: budgeted.selectedBlocks };
}

export function serializeBudgetedContextForPrompt(blocks: PrioritizedContextBlock[]): {
  promptText: string;
  estimatedTokens: number;
} {
  const promptText = blocks.map((b) => `### ${b.label}\n${b.text}`).join("\n\n");
  return {
    promptText,
    estimatedTokens: estimateTokens(promptText),
  };
}
