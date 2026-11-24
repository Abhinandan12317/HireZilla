import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { config } from "../backend/src/config";
import {
  readPrivateResumeFile,
  storePrivateResumeFile,
} from "../backend/src/services/pdfProcessor";
import { safeExternalUrl, sanitizeReturnTo } from "../frontend/src/lib/navigation";

describe("Security Controls — Path Confinement, URL & Redirect Sanitization", () => {
  it("confines private resume reads strictly within privateStorageDir (blocks ../ and sibling prefix)", () => {
    const validKey = storePrivateResumeFile({
      companyId: "cmp_sec_test",
      jobId: "job_sec_test",
      fileId: "file_sec_test",
      buffer: Buffer.from("%PDF-1.4\n%test"),
    });

    // Legitimate stored resume resolves cleanly
    const readOk = readPrivateResumeFile(validKey);
    expect(readOk).not.toBeNull();
    expect(readOk?.toString("ascii").startsWith("%PDF-")).toBe(true);

    // Classic dot-dot traversal rejected
    expect(readPrivateResumeFile("../../package.json")).toBeNull();
    expect(readPrivateResumeFile("resumes/../../../etc/passwd")).toBeNull();
    expect(readPrivateResumeFile("resumes/\0evil.pdf")).toBeNull();

    // Sibling prefix directory collision (e.g. private_storage_evil) rejected
    const baseDir = path.resolve(config.privateStorageDir);
    const siblingDir = `${baseDir}_evil`;
    fs.mkdirSync(siblingDir, { recursive: true });
    const siblingFile = path.join(siblingDir, "secret.pdf");
    fs.writeFileSync(siblingFile, "%PDF-1.4\nsecret");

    try {
      const siblingRel = `../${path.basename(siblingDir)}/secret.pdf`;
      expect(readPrivateResumeFile(siblingRel)).toBeNull();
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
      fs.rmSync(path.join(baseDir, "resumes", "cmp_sec_test"), {
        recursive: true,
        force: true,
      });
    }
  });

  it("blocks open-redirect returnTo payloads while preserving safe app-relative paths", () => {
    expect(sanitizeReturnTo("/jobs/job_backend_sr/apply")).toBe("/jobs/job_backend_sr/apply");
    expect(sanitizeReturnTo("  /student/dashboard?tab=1 ")).toBe("/student/dashboard?tab=1");

    expect(sanitizeReturnTo("//evil.com/phish")).toBeNull();
    expect(sanitizeReturnTo("/\\evil.com/phish")).toBeNull();
    expect(sanitizeReturnTo("https://evil.com/login")).toBeNull();
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeNull();
    expect(sanitizeReturnTo("/jobs\r\nLocation: https://evil.com")).toBeNull();
    expect(sanitizeReturnTo("")).toBeNull();
  });

  it("blocks dangerous external URL schemes (javascript:, data:, vbscript:) and allows http/https", () => {
    expect(safeExternalUrl("https://github.com/hirezilla")).toBe("https://github.com/hirezilla");
    expect(safeExternalUrl("http://example.com/portfolio")).toBe("http://example.com/portfolio");

    expect(safeExternalUrl("javascript:alert(document.cookie)")).toBeUndefined();
    expect(safeExternalUrl("JAVASCRIPT:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeExternalUrl("vbscript:msgbox(1)")).toBeUndefined();
    expect(safeExternalUrl("not a url")).toBeUndefined();
  });
});
