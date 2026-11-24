import type { ResumeCategoryKey, TieReasonCode } from "./constants";

export type UserRole = "student" | "recruiter" | "admin";
export type UserStatus = "active" | "suspended";

export type AuthMethod = "password" | "google" | "passwordless";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole | null;
  status: UserStatus;
  avatarUrl?: string;
  companyId?: string | null;
  isDemo?: boolean;
  passwordHash?: string;
  hasPassword?: boolean;
  authMethods?: AuthMethod[];
  passwordUpdatedAt?: string | null;
  sessionVersion?: number;
  createdAt: string;
}

export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  email?: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export type CompanyStatus = "active" | "suspended";
export type CompanyVerificationStatus = "not_verified";

export interface Company {
  id: string;
  name: string;
  website?: string;
  industry?: string;
  size?: string;
  location?: string;
  description?: string;
  logoUrl?: string;
  ownerUserId: string;
  memberUserIds: string[];
  status: CompanyStatus;
  verificationStatus: CompanyVerificationStatus;
  packageCode: "HATCHLING_FREE";
  packageActivatedAt: string | null;
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EducationItem {
  id: string;
  institution: string;
  qualification: string;
  fieldOfStudy: string;
  startYear: number;
  endYear?: number | null;
  status: "ongoing" | "completed";
  coursework?: string;
}

export interface SkillItem {
  name: string;
  selfRating?: "beginner" | "intermediate" | "advanced";
}

export interface ProjectItem {
  id: string;
  title: string;
  description: string;
  roleContribution: string;
  technologies: string[];
  projectUrl?: string;
  githubUrl?: string;
  demoUrl?: string;
}

export interface CertificationItem {
  id: string;
  name: string;
  issuer: string;
  date?: string;
  credentialUrl?: string;
}

export interface StudentPortfolio {
  id: string;
  userId: string;
  slug: string;
  displayName: string;
  email: string;
  headline?: string;
  phone?: string;
  location?: string;
  summary?: string;
  education: EducationItem[];
  skills: SkillItem[];
  projects: ProjectItem[];
  links: {
    linkedin?: string;
    github?: string;
    website?: string;
  };
  certifications: CertificationItem[];
  visibility: "private" | "public";
  onboardingCompleted: boolean;
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type JobStatus = "draft" | "open" | "paused" | "closed" | "hidden";
export type WorkMode = "remote" | "hybrid" | "onsite";
export type EmploymentType = "full_time" | "internship" | "contract" | "part_time";
export type RequirementPriority = "mandatory" | "preferred" | "informational";

export interface JobCriterion {
  id: string;
  category: ResumeCategoryKey;
  requirement: string;
  priority: RequirementPriority;
  sourceText: string;
  evaluationGuidance: string;
}

export interface JobEvaluationProfile {
  id: string;
  jobId: string;
  companyId: string;
  profileVersion: string;
  rubricVersion: "P1-v1";
  jobTitle: string;
  criteria: JobCriterion[];
  ambiguities: string[];
  status: "ready" | "needs_review" | "failed" | "stale";
  model: string;
  promptVersion: string;
  failureMessageSafe?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface JobPosting {
  id: string;
  companyId: string;
  companyName: string;
  companyVerificationStatus: CompanyVerificationStatus;
  title: string;
  department?: string;
  employmentType: EmploymentType;
  workMode: WorkMode;
  location: string;
  experienceLevel: string;
  experienceYearsMin?: number;
  experienceYearsMax?: number;
  educationRequirement?: string;
  eligibilityRequirements?: string[];
  summary: string;
  description: string;
  responsibilities: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  compensationDisplay?: string;
  applicationCap: number;
  applicationCount: number;
  status: JobStatus;
  activeEvaluationProfileId?: string | null;
  activeEvaluationProfileVersion?: string | null;
  evaluationProfileStatus: "none" | "ready" | "needs_review" | "failed" | "stale";
  closingDate?: string | null;
  isDemo?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ResumeProcessingStatus =
  | "uploaded"
  | "validating"
  | "extracting"
  | "extracted"
  | "extraction_failed"
  | "rejected";

export type EvaluationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "needs_review"
  | "failed";

export type ScreeningResult = "qualified" | "not_qualified" | "not_determined";

export type RecruiterDecision =
  | "pending"
  | "shortlisted"
  | "interview_invited"
  | "selected"
  | "not_selected"
  | "on_hold";

export type ApplicationStatus =
  | "submitted"
  | "screening_in_progress"
  | "screening_completed"
  | "screening_needs_review"
  | "screening_failed"
  | "shortlisted"
  | "interview_invited"
  | "interview_completed"
  | "on_hold"
  | "selected"
  | "not_selected";

export type EvidenceStatus =
  | "demonstrated"
  | "not_demonstrated"
  | "unclear"
  | "not_applicable";

export interface EvidenceItem {
  description: string;
  excerpt?: string;
  pageNumber?: number;
  extractionReference?: string;
  criterionId?: string;
  evidenceStatus: EvidenceStatus;
}

export interface CategoryEvaluation {
  category: ResumeCategoryKey;
  score: number;
  evidence: EvidenceItem[];
  matchedCriteria: string[];
  unmatchedCriteria: string[];
  explanation: string;
  confidence: "high" | "medium" | "low";
  limitations: string[];
}

export interface ResumeFileRecord {
  id: string;
  applicationId?: string;
  candidateId: string;
  jobId: string;
  companyId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  storageKey: string;
  processingStatus: ResumeProcessingStatus;
  extractionReference: string;
  extractedTextLength: number;
  extractedText?: string | null;
  pageAnnotatedText?: string | null;
  failureCode?: string | null;
  failureMessageSafe?: string | null;
  version: string;
  createdAt: string;
}

export interface ResumeEvaluationRecord {
  id: string;
  applicationId: string;
  candidateId: string;
  jobId: string;
  companyId: string;
  resumeFileId: string;
  resumeFileVersion: string;
  extractionStatus: ResumeProcessingStatus;
  extractionReference: string;
  evaluationStatus: EvaluationStatus;
  screeningResult: ScreeningResult;
  categoryScores: Record<ResumeCategoryKey, number> | null;
  categoryEvaluations: CategoryEvaluation[];
  weightedScore: number | null;
  qualificationThreshold: number;
  isReferralAtEvaluation: boolean;
  jobEvaluationProfileId: string;
  jobEvaluationProfileVersion: string;
  rubricVersion: "P1-v1";
  model: string;
  promptVersion: string;
  overallObservations: string[];
  reviewFlags: string[];
  failureCode: string | null;
  failureMessageSafe: string | null;
  reviewResolved?: boolean;
  reviewResolutionNote?: string | null;
  reviewResolvedBy?: string | null;
  reviewResolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApplicationRecord {
  id: string;
  jobId: string;
  companyId: string;
  candidateId: string;
  candidateName: string;
  candidateEmail: string;
  portfolioSlug?: string | null;
  coverLetter?: string;
  resumeFileId: string;
  resumeFilename: string;
  resumeProcessingStatus: ResumeProcessingStatus;
  evaluationStatus: EvaluationStatus;
  screeningResult: ScreeningResult;
  weightedScore: number | null;
  isReferral: boolean;
  referralCodeUsed?: string | null;
  recruiterDecision: RecruiterDecision;
  applicationStatus: ApplicationStatus;
  recruiterNotes?: string;
  decisionReason?: string | null;
  interviewId?: string | null;
  interviewStatus?: InterviewStatus | null;
  reviewFlags: string[];
  submittedAt: string;
  updatedAt: string;
}

export interface ReferralTokenRecord {
  id: string;
  code: string;
  companyId: string;
  jobId?: string | null;
  referrerName: string;
  referrerEmail: string;
  active: boolean;
  expiresAt: string | null;
  usedCount: number;
  maxUses: number | null;
  createdAt: string;
}

export interface TieResolutionRecord {
  id: string;
  jobId: string;
  companyId: string;
  weightedScore: number;
  candidateApplicationIds: string[];
  outcome: "selected_one" | "progress_both" | "not_proceeding_either";
  selectedApplicationIds: string[];
  reasonCode: TieReasonCode;
  note: string;
  recruiterId: string;
  createdAt: string;
}

export interface InterviewQuestion {
  id: string;
  prompt: string;
  competency: string;
  category?: string;
  sourceContext?: string;
  difficulty?: "foundational" | "intermediate" | "advanced";
  rubricSignals: string[];
  evaluationCriteria?: string[];
  weaknessIndicators?: string[];
  followUpCondition?: string;
  expectedTimeMinutes?: number;
}

export interface CandidateContextEvidenceItem {
  source: "resume" | "javascript_skills" | "project";
  skillOrCompetency: string;
  evidenceSummary: string;
  projectAssociation?: string | null;
  confidence: "high" | "medium" | "low";
  interviewOpportunity: string;
}

export interface InterviewContextRecord {
  contextVersion: string;
  generatedAt: string;
  sourcesAvailable: {
    resume: boolean;
    javascriptProfile: boolean;
    projects: boolean;
  };
  resumeHighlights: {
    technicalSkills: string[];
    workExperienceSummaries: string[];
    educationSummary: string | null;
    unverifiedClaims: string[];
  };
  javascriptSkillProfile: {
    demonstratedConcepts: string[];
    claimedConcepts: string[];
    technicalStrengths: string[];
    potentialGaps: string[];
    confidenceNote: string;
  };
  projectMappings: Array<{
    title: string;
    objective: string;
    roleContribution: string;
    technologies: string[];
    repositoryUrl?: string | null;
    repositoryFetched: false;
  }>;
  evidenceItems: CandidateContextEvidenceItem[];
  budgetMetadata: {
    maxContextTokens: number;
    estimatedTokensUsed: number;
    truncated: boolean;
    omittedItemsCount: number;
  };
}

export interface InterviewQuestionSet {
  id: string;
  jobId: string;
  companyId: string;
  version: number;
  status: "draft" | "published";
  durationMinutes: number;
  questions: InterviewQuestion[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type InterviewStatus =
  | "invited"
  | "in_progress"
  | "submitted"
  | "report_ready"
  | "report_failed"
  | "expired"
  | "revoked";

export interface InterviewAnswer {
  questionId: string;
  answerText: string;
  wordCount: number;
  updatedAt: string;
  timeSpentSeconds?: number;
}

export interface InterviewDimensionScore {
  name: string;
  score: number;
  rubricTarget: number;
  summary: string;
}

export interface InterviewQuestionEvaluation {
  questionId: string;
  questionPrompt: string;
  competency: string;
  score: number;
  ratingLabel: string;
  rubricChecks: string[];
  evidenceFromAnswer: string;
  evaluatorNote: string;
  strengths?: string[];
  weaknesses?: string[];
  missingConcepts?: string[];
  reasoningQuality?: string;
  technicalCorrectness?: string;
  practicalUnderstanding?: string;
  suggestedFollowUp?: string;
  portfolioCitation?: string;
  confidence: "high" | "medium" | "low";
  limitations: string[];
}

export interface InterviewReport {
  id: string;
  interviewId: string;
  applicationId: string;
  jobId: string;
  companyId: string;
  overallInterviewScore: number;
  atsCumulativeScore: number | null;
  targetLevelLabel: string;
  confidence: "high" | "medium" | "low";
  dimensions: InterviewDimensionScore[];
  synthesisSummary: string;
  verifiedStrengths: string[];
  recommendedDeepDive: string;
  questionEvaluations: InterviewQuestionEvaluation[];
  model: string;
  promptVersion: string;
  recruiterRecommendation?: "strong_no" | "no_hire" | "neutral" | "hire" | "strong" | null;
  recruiterNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewSession {
  id: string;
  applicationId: string;
  jobId: string;
  companyId: string;
  candidateId: string;
  candidateName: string;
  recruiterId?: string;
  questionSetId: string;
  questionSetVersion: number;
  questions: InterviewQuestion[];
  questionGenerationStatus?: "pending" | "ready" | "failed";
  questionGenerationErrorSafe?: string | null;
  interviewContext?: InterviewContextRecord | null;
  /** Cryptographic SHA-256 hash of invitation token (raw token is never stored in DB) */
  tokenHash: string;
  tokenHint: string;
  /** Optional deprecated legacy field only when reading unmigrated JSON records */
  token?: string;
  status: InterviewStatus;
  evaluationStatus?: "pending" | "processing" | "ready" | "failed";
  evaluationErrorSafe?: string | null;
  durationMinutes: number;
  deadlineAt: string;
  invitedAt: string;
  revokedAt?: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  lastActivityAt?: string | null;
  activeSessionNonce?: string | null;
  activeSessionUpdatedAt?: string | null;
  answers: InterviewAnswer[];
  emailDeliveryStatus: "sent" | "failed" | "pending";
  reportId?: string | null;
  aiMetadata?: {
    model: string;
    promptVersion: string;
    keyUsed?: "primary" | "fallback";
    fallbackActivated?: boolean;
    promptTokensEstimate?: number;
    truncated?: boolean;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  } | null;
  auditTrail: Array<{ timestamp: string; message: string }>;
}

export interface ReportFlagRecord {
  id: string;
  targetType: "job" | "company" | "user";
  targetId: string;
  targetTitle: string;
  reporterUserId: string | null;
  reason: string;
  details?: string;
  status: "open" | "dismissed" | "action_taken";
  resolutionNote?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  actorId: string;
  actorRole: UserRole | "system";
  action: string;
  targetType: string;
  targetId: string;
  companyId?: string | null;
  reason?: string | null;
  previousState?: unknown;
  newState?: unknown;
  requestId?: string;
  createdAt: string;
}

export interface NotificationEmailRecord {
  id: string;
  toEmail: string;
  toName: string;
  subject: string;
  bodyText: string;
  templateType:
    | "shortlist"
    | "interview_invite"
    | "interview_submitted"
    | "decision_update"
    | "password_reset";
  relatedApplicationId?: string;
  relatedInterviewId?: string;
  status: "sent_dev_outbox" | "failed";
  errorMessage?: string | null;
  createdAt: string;
}
