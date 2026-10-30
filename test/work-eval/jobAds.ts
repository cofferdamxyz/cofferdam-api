// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real job ads as the Mac-side benchmarks read them: the jobs benchmark
 * (`test/workJobs.eval.test.ts`) and the job-profile evaluation
 * (`test/workJobProfile.eval.test.ts`). An ad is a stranger's text: before
 * any hosted model reads it, its contact details and links become the
 * phone's placeholders, so the plane's tripwire reads an ad as it reads a
 * CV. Moved here unchanged from the jobs benchmark on 2026-10-30.
 */

/** Contact details and links as the phone's placeholders, so the plane's tripwire reads an ad as it reads a CV. */
export function deidentify(text: string): string {
  const counters: Record<string, number> = {};
  const mark = (cls: string) => {
    counters[cls] = Math.min(99, (counters[cls] ?? 0) + 1);
    return `[${cls}_${counters[cls]}]`;
  };
  return text
    .replace(/\r/g, '')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, (_m, label: string) => `${label} ${mark('LINK')}`)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, () => mark('EMAIL'))
    .replace(/\bhttps?:\/\/\S+/gi, () => mark('LINK'))
    .replace(/\bwww\.\S+/gi, () => mark('LINK'))
    .replace(/\b[\w-]+\.(com|net|org|io|co|gov|edu|br|mx)\b(\/\S*)?/gi, () => mark('LINK'))
    .replace(/(^|\s)@[\w.]{3,}/g, (_m, lead: string) => `${lead}${mark('ID')}`)
    .replace(/\+?\(?\d{2,4}\)?[\s.-]\d{3,5}[\s.-]\d{4}\b/g, () => mark('PHONE'))
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\\([*_#\-.])/g, '$1')
    .replace(/^\s*[*•·]\s+/gm, '- ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
