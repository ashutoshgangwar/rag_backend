const { generateAnswer } = require('../services/ollama.service');

/**
 * Decide whether an extracted PDF really is a RESUME / CV.
 *
 * Why this exists: the upload route only proves a file is a PDF. It cannot
 * tell a resume from a bank statement, an Aadhaar scan or a 200-page manual -
 * and this knowledge base is meant to hold resumes only.
 *
 * Two tiers, on purpose:
 *
 *   1. A keyword/structure heuristic. Free, instant, and decisive for the
 *      large majority of files: a resume names its sections (experience,
 *      education, skills) and carries contact details, and it is short.
 *   2. The local LLM, but ONLY for the grey band the heuristic is unsure
 *      about. Asking llama3.2 about every upload would add seconds per file
 *      for verdicts the heuristic already knows.
 *
 * Nothing leaves this machine - the LLM is the same local Ollama the rest of
 * the app uses, and it only ever sees the first page or so of text.
 */

/** Below this much extracted text there is nothing to classify at all. */
const MIN_TEXT_CHARS = 200;

/** A resume is a short document. Well past this, it is something else. */
const MAX_RESUME_PAGES = 15;
const MAX_RESUME_CHARS = 40000;

/** How much text the LLM tier sees. Roughly the first page. */
const LLM_EXCERPT_CHARS = 1800;

/**
 * Section concepts, not raw keywords. Each GROUP scores at most once, so a
 * heading like "Work Experience" cannot inflate the score by also matching
 * the bare word "experience".
 */
const SECTION_GROUPS = {
  experience: /\b(work|professional|employment)\s+(experience|history)\b|\bexperience\b|\binternships?\b/,
  education: /\beducation\b|\bacademics?\b|\bqualifications?\b|\b(b\.?tech|m\.?tech|b\.?sc|m\.?sc|bachelor|master|mba|phd)\b/,
  skills: /\b(technical\s+)?skills\b|\btech(nologies)?\s+stack\b|\bcompetenc(y|ies)\b/,
  projects: /\bprojects?\b/,
  summary: /\b(career\s+)?objective\b|\b(professional\s+)?summary\b|\bprofile\b|\babout\s+me\b/,
  credentials: /\bcertifications?\b|\bachievements?\b|\bawards?\b|\bpublications?\b/,
  extras: /\blanguages\b|\bhobbies\b|\binterests\b|\breferences\b|\bextra[-\s]?curricular\b/,
  explicit: /\bcurriculum\s+vitae\b|\bresume\b|\bcv\b/,
};

/** Details a person puts on their own resume and almost nowhere else. */
const CONTACT_SIGNALS = {
  email: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
  phone: /(?:\+?\d[\d\s().-]{7,}\d)/,
  linkedin: /linkedin\.com\/in\//i,
  github: /github\.com\//i,
};

/**
 * Phrases that identify a document as something else entirely. Two of these
 * outweigh any accidental section-word matches - an offer letter mentions
 * "experience" and "salary" but is still not a resume.
 */
const NEGATIVE_SIGNALS = [
  /\b(bank|account)\s+statement\b/,
  /\bstatement\s+of\s+account\b/,
  /\b(tax\s+)?invoice\b/,
  /\bpurchase\s+order\b/,
  /\bpay\s?slip\b|\bsalary\s+slip\b/,
  /\bgovernment\s+of\s+india\b/,
  /\baadhaar\b|\bunique\s+identification\s+authority\b/,
  /\bpermanent\s+account\s+number\b/,
  /\bpassport\s+no\b/,
  /\bterms\s+and\s+conditions\b/,
  /\bprivacy\s+policy\b/,
  /\bthis\s+agreement\b|\bhereinafter\s+referred\s+to\b/,
  /\boffer\s+letter\b|\bappointment\s+letter\b/,
  /\bmark\s?sheet\b|\bgrade\s+card\b/,
  /\btable\s+of\s+contents\b/,
  /\bpolicy\s+number\b|\bpremium\s+amount\b/,
];

/**
 * Classify extracted PDF text.
 *
 * @param {string} text  full extracted text
 * @param {{ pageCount?: number, filename?: string, useLlm?: boolean }} [opts]
 * @returns {Promise<{isResume: boolean, confidence: number, reason: string, method: string, needsOcr: boolean, signals: object}>}
 */
async function classifyResume(text, opts = {}) {
  const { pageCount = null, filename = 'the file', useLlm = llmTierEnabled() } = opts;
  const heuristic = scoreHeuristically(text, pageCount);

  // No readable text: a scanned resume is still a resume, so this is NOT a
  // rejection - it is a different problem (OCR) and gets its own verdict.
  if (heuristic.needsOcr) return heuristic;

  // Confident either way - do not spend seconds of LLM time on it.
  if (heuristic.verdict !== 'unsure') return finalize(heuristic);

  if (!useLlm) {
    // Grey band with the LLM tier switched off: lean on the raw score.
    return finalize({
      ...heuristic,
      verdict: heuristic.score >= 4 ? 'resume' : 'not-resume',
      confidence: 0.55,
      reason:
        heuristic.score >= 4
          ? 'Has some resume sections, but the match is weak.'
          : `"${filename}" does not read like a resume - too few resume sections found.`,
      method: 'heuristic',
    });
  }

  return finalize(await askLlm(text, heuristic, filename));
}

/** Tier 1: keywords, contact details and document shape. */
function scoreHeuristically(text, pageCount) {
  const clean = String(text || '').toLowerCase();
  const chars = clean.trim().length;

  if (chars < MIN_TEXT_CHARS) {
    return {
      isResume: false,
      needsOcr: true,
      verdict: 'needs-ocr',
      confidence: 0,
      score: 0,
      method: 'heuristic',
      reason:
        'Almost no text could be read from this PDF. If it is a scanned or ' +
        'photographed resume, run it through OCR and upload the text version.',
      signals: { sections: [], contacts: [], negatives: [], chars, pageCount },
    };
  }

  const sections = Object.keys(SECTION_GROUPS).filter((k) => SECTION_GROUPS[k].test(clean));
  const contacts = Object.keys(CONTACT_SIGNALS).filter((k) => CONTACT_SIGNALS[k].test(clean));
  const negatives = NEGATIVE_SIGNALS.filter((re) => re.test(clean)).map((re) => re.source);
  const tooLong = (pageCount && pageCount > MAX_RESUME_PAGES) || chars > MAX_RESUME_CHARS;

  const base = {
    needsOcr: false,
    score: sections.length + contacts.length,
    method: 'heuristic',
    signals: { sections, contacts, negatives, chars, pageCount },
  };

  // --- decisive NO ---
  if (negatives.length >= 2) {
    return {
      ...base,
      verdict: 'not-resume',
      confidence: 0.92,
      reason: 'This reads like a statement, invoice or official document, not a resume.',
    };
  }
  if (tooLong) {
    return {
      ...base,
      verdict: 'not-resume',
      confidence: 0.85,
      reason: `Far too long for a resume (${pageCount || '?'} pages, ${chars} characters).`,
    };
  }
  if (sections.length <= 1) {
    return {
      ...base,
      verdict: 'not-resume',
      confidence: 0.82,
      reason: 'None of the usual resume sections (experience, education, skills) are present.',
    };
  }

  // --- decisive YES ---
  if (sections.length >= 4 && contacts.length >= 1) {
    return {
      ...base,
      verdict: 'resume',
      confidence: 0.94,
      reason: `Found resume sections (${sections.join(', ')}) and contact details.`,
    };
  }
  if (sections.length >= 6) {
    return {
      ...base,
      verdict: 'resume',
      confidence: 0.86,
      reason: `Found resume sections: ${sections.join(', ')}.`,
    };
  }

  // --- everything else goes to the LLM ---
  return { ...base, verdict: 'unsure', confidence: 0.5, reason: 'Inconclusive on keywords alone.' };
}

/** The label set the LLM must choose from, and how each reads in a message. */
const LABEL_PHRASES = {
  RESUME: 'a resume',
  LETTER: 'a letter',
  STATEMENT: 'a statement, invoice or bill',
  ID: 'an ID, certificate or official record',
  ARTICLE: 'an article, report or manual',
  OTHER: 'another kind of document',
};

/**
 * Tier 2: ask the local LLM about the first page.
 *
 * Forced-choice labelling, NOT a yes/no question. Asked "is this a resume?",
 * llama3.2 says yes to almost anything with the word "education" in it - it
 * even labelled a textbook chapter a resume while explaining that it was a
 * textbook chapter. Making it name the document type instead removes that
 * yes-bias, and only the RESUME label counts as a pass.
 */
async function askLlm(text, heuristic, filename) {
  const excerpt = String(text).replace(/\s+/g, ' ').trim().slice(0, LLM_EXCERPT_CHARS);

  const prompt = [
    'Classify the document below into exactly ONE of these types:',
    '',
    'RESUME - a person describing THEIR OWN work experience, education and',
    '         skills in order to apply for a job (a CV).',
    'LETTER - offer letter, appointment letter, cover letter, any correspondence.',
    'STATEMENT - bank or account statement, payslip, invoice, bill, receipt.',
    'ID - identity card, government document, certificate, marksheet, degree.',
    'ARTICLE - book chapter, research paper, report, manual, policy or documentation.',
    'OTHER - anything that fits none of the above.',
    '',
    'A document that merely MENTIONS education, skills or jobs is not a RESUME',
    'unless it is one person presenting their own career history.',
    '',
    'Reply with EXACTLY two lines and nothing else:',
    'TYPE: <one label from the list above>',
    'REASON: <at most 12 words>',
    '',
    '--- DOCUMENT START ---',
    excerpt,
    '--- DOCUMENT END ---',
  ].join('\n');

  let raw;
  try {
    raw = await generateAnswer(prompt, { temperature: 0 });
  } catch (err) {
    // Ollama down should not block every upload, so fall back to the score
    // rather than failing the request outright.
    console.warn(`[resume-check] LLM tier unavailable, using heuristic: ${err.message}`);
    return heuristicFallback(heuristic, filename, 'classifier model unavailable');
  }

  const typeMatch = raw.match(/type\s*:\s*([a-z_]+)/i);
  const reasonMatch = raw.match(/reason\s*:\s*(.+)/i);
  const label = typeMatch ? typeMatch[1].toUpperCase() : null;
  const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 160) : '';

  // An unparseable or invented label is not a verdict - do not guess from it.
  if (!label || !LABEL_PHRASES[label]) {
    return heuristicFallback(heuristic, filename, 'could not classify confidently');
  }

  const isResume = label === 'RESUME';
  return {
    ...heuristic,
    verdict: isResume ? 'resume' : 'not-resume',
    confidence: 0.8,
    method: 'llm',
    reason: isResume
      ? reason || 'Reads like a resume.'
      : `This looks like ${LABEL_PHRASES[label]}, not a resume.${reason ? ` (${reason})` : ''}`,
  };
}

/** When the LLM tier cannot answer, decide on the heuristic score alone. */
function heuristicFallback(heuristic, filename, why) {
  const pass = heuristic.score >= 4;
  return {
    ...heuristic,
    verdict: pass ? 'resume' : 'not-resume',
    confidence: 0.55,
    method: 'heuristic-fallback',
    reason: pass
      ? `Has resume-like sections (${why}).`
      : `"${filename}" does not read like a resume (${why}).`,
  };
}

/** Collapse the internal verdict into the public shape. */
function finalize(result) {
  return {
    isResume: result.verdict === 'resume',
    needsOcr: Boolean(result.needsOcr),
    confidence: Number(result.confidence.toFixed(2)),
    reason: result.reason,
    method: result.method,
    signals: result.signals,
  };
}

/** RESUME_ONLY=false turns the whole gate off (useful for a generic corpus). */
function resumeOnlyEnabled() {
  return String(process.env.RESUME_ONLY ?? 'true').toLowerCase() !== 'false';
}

/** RESUME_LLM_CHECK=false keeps the fast heuristic but skips the LLM tier. */
function llmTierEnabled() {
  return String(process.env.RESUME_LLM_CHECK ?? 'true').toLowerCase() !== 'false';
}

module.exports = { classifyResume, resumeOnlyEnabled, llmTierEnabled };
