/**
 * The built-in agent catalog, seeded into the `agents` collection at startup
 * (see ensureAgents in services/agent.service.js).
 *
 * Every agent here only WRITES text - answers, explanations, drafts, plans.
 * None of them books, orders, pays or fetches live data, and each system
 * prompt says so where a user might expect otherwise.
 *
 * `allowCode` decides whether an agent may answer with ``` code blocks; only
 * the coding agent does. A stored agent without it counts as false.
 *
 * `systemPrompt`, `enabled` and `order` are server-side only: they are
 * stripped before an agent is sent to the frontend.
 */

const GROUPS = [
  { id: 'education', label: 'Education' },
  { id: 'work', label: 'Corporate & Work' },
  { id: 'life', label: 'Plans & Ideas' },
];

/* eslint-disable max-len -- one agent per line, kept identical to the spec */
const DEFINITIONS = [
  {"id":"tutor","name":"Study Q&A","tagline":"Clear answers to any subject question, step by step.","group":"education","icon":"cap","hue":"#6366f1","mode":"answer","allowCode":false,"cta":"Get answer","keywords":["question","explain","study","homework","physics","maths","math","chemistry","biology","history"],"fields":[{"name":"subject","label":"Subject","type":"select","options":["Any","Maths","Physics","Chemistry","Biology","History","Economics","English"]},{"name":"level","label":"Level","type":"select","options":["School","Higher secondary","Undergraduate","Postgraduate"]},{"name":"request","label":"Your question","type":"textarea","placeholder":"Why is the sky blue?","required":true,"wide":true}],"examples":["Explain photosynthesis simply","Solve x² − 5x + 6 = 0","Causes of World War I"]},
  {"id":"exam","name":"Exam Prep","tagline":"Practice quizzes, revision notes and study plans.","group":"education","icon":"checklist","hue":"#14b8a6","mode":"answer","allowCode":false,"cta":"Build my prep","keywords":["exam","quiz","revision","test","jee","neet","upsc","cat","practice"],"fields":[{"name":"exam","label":"Exam","type":"text","placeholder":"JEE Main, class 12 boards…","required":true},{"name":"topic","label":"Topic","type":"text","placeholder":"Thermodynamics"},{"name":"format","label":"I want","type":"select","options":["Practice quiz","Revision notes","Study plan"]},{"name":"request","label":"Anything else?","type":"textarea","placeholder":"Exam is in 3 weeks, weak in numericals…","wide":true}],"examples":["10 MCQs on Newton’s laws","2-week plan for organic chemistry"]},
  {"id":"code","name":"Coding Mentor","tagline":"Debug code, learn concepts, and review solutions.","group":"education","icon":"code","hue":"#0891b2","mode":"answer","allowCode":true,"cta":"Ask mentor","keywords":["code","coding","bug","error","javascript","python","java","react","programming","dsa"],"fields":[{"name":"language","label":"Language","type":"select","options":["Any","JavaScript","Python","Java","C++","SQL"]},{"name":"request","label":"Your question or code","type":"textarea","placeholder":"Paste code or describe the problem…","required":true,"wide":true,"rows":6}],"examples":["Explain closures in JavaScript","Reverse a linked list in Python"]},
  {"id":"career","name":"Career Guide","tagline":"Courses, skills and career paths that suit you.","group":"education","icon":"compass","hue":"#a855f7","mode":"answer","allowCode":false,"cta":"Get guidance","keywords":["career","college","course","admission","job switch","resume","cv"],"fields":[{"name":"stage","label":"Where are you now?","type":"select","options":["School student","College student","Working professional","Career break"]},{"name":"interests","label":"Interests","type":"text","placeholder":"Design, data, biology…"},{"name":"request","label":"What do you want to figure out?","type":"textarea","placeholder":"Should I do an MBA or a master’s in data science?","required":true,"wide":true}],"examples":["Move from testing to development","Best courses after 12th commerce"]},
  {"id":"email","name":"Email Writer","tagline":"Professional emails and replies in the right tone.","group":"work","icon":"mail","hue":"#2563eb","mode":"answer","allowCode":false,"cta":"Draft email","keywords":["email","mail","reply","write to","draft"],"fields":[{"name":"to","label":"Writing to","type":"text","placeholder":"Client, manager, HR…"},{"name":"tone","label":"Tone","type":"select","options":["Professional","Friendly","Firm","Apologetic","Persuasive"]},{"name":"request","label":"What should it say?","type":"textarea","placeholder":"Ask for a 1-week extension on the Q3 report…","required":true,"wide":true}],"examples":["Follow up on an unpaid invoice","Politely decline a meeting"]},
  {"id":"meeting","name":"Meeting Planner","tagline":"Agenda, invite text and talking points for any meeting.","group":"work","icon":"calendar","hue":"#0d9488","mode":"answer","allowCode":false,"cta":"Plan meeting","keywords":["meeting","agenda","invite","call","sync","standup"],"fields":[{"name":"title","label":"Meeting about","type":"text","placeholder":"Q3 planning","required":true},{"name":"duration","label":"Duration","type":"select","options":["30 min","15 min","45 min","60 min"]},{"name":"attendees","label":"Who is attending?","type":"text","placeholder":"Design team, client, leadership…"},{"name":"request","label":"Goals or notes","type":"textarea","placeholder":"Decide launch date, review budget…","wide":true}],"examples":["Weekly team sync agenda","Kick-off call with a new client"]},
  {"id":"summary","name":"Doc & Report Summary","tagline":"Summaries, key points and action items from any text.","group":"work","icon":"doc","hue":"#7c3aed","mode":"answer","allowCode":false,"cta":"Summarise","keywords":["summary","summarise","summarize","report","minutes","notes","tl;dr"],"fields":[{"name":"format","label":"Output","type":"select","options":["Key points","Executive summary","Action items","Meeting minutes"]},{"name":"request","label":"Paste the text","type":"textarea","placeholder":"Paste a report, transcript or long email…","required":true,"wide":true,"rows":7}]},
  {"id":"data","name":"Data Insights","tagline":"Paste your numbers and ask what they mean.","group":"work","icon":"chart","hue":"#06b6d4","mode":"answer","allowCode":false,"cta":"Analyse","keywords":["data","analysis","sales","revenue","kpi","metrics","excel","forecast"],"fields":[{"name":"area","label":"Area","type":"select","options":["Sales","Marketing","Finance","Operations","HR"]},{"name":"data","label":"Your data (optional)","type":"textarea","placeholder":"Paste a small table or CSV: month, region, revenue…","wide":true,"rows":5},{"name":"request","label":"Your question","type":"textarea","placeholder":"Which region is falling behind, and why might that be?","required":true,"wide":true}],"examples":["Which KPIs should a SaaS startup track?","How to forecast next quarter sales"]},
  {"id":"trip","name":"Trip Planner","tagline":"Day-by-day itineraries built around what you like.","group":"life","icon":"map","hue":"#10b981","mode":"answer","allowCode":false,"cta":"Plan my trip","keywords":["trip","itinerary","vacation","holiday","travel plan","tour"],"fields":[{"name":"city","label":"Where to?","type":"text","placeholder":"Kerala","required":true},{"name":"days","label":"Days","type":"number","default":4,"min":1,"max":21},{"name":"style","label":"Travel style","type":"select","options":["Relaxed","Adventure","Culture & food","Family"]},{"name":"request","label":"What do you enjoy?","type":"textarea","placeholder":"Beaches, local food, less walking…","wide":true}],"examples":["Honeymoon, lots of nature","With kids and grandparents","Backpacking on a budget"]},
  {"id":"gift","name":"Gift Ideas","tagline":"Thoughtful gift ideas for anyone, within your budget.","group":"life","icon":"gift","hue":"#ec4899","mode":"answer","allowCode":false,"cta":"Suggest gifts","keywords":["gift","present","birthday gift","anniversary"],"fields":[{"name":"for","label":"Who is it for?","type":"text","placeholder":"My sister, 24, loves books","required":true},{"name":"occasion","label":"Occasion","type":"select","options":["Birthday","Anniversary","Wedding","Festival","Thank you"]},{"name":"budget","label":"Budget (₹)","type":"number","placeholder":"2000","min":0},{"name":"request","label":"Anything else?","type":"textarea","placeholder":"Handmade, personalised, experience gifts…","wide":true}],"examples":["Farewell gift for a colleague","Anniversary gift under ₹3,000"]},
];
/* eslint-enable max-len */

const SYSTEM_PROMPTS = {
  tutor:
    "You are a patient tutor. Explain at the student's level, step by step, with one worked example. If the question is outside the chosen subject, answer it anyway.",
  exam:
    "You are an exam coach. Produce exactly what was asked (quiz, revision notes or study plan) for the named exam and topic. For a quiz, number the questions and put all answers in a final 'Answers' section.",
  code:
    'You are a senior programming mentor. Explain the concept or bug clearly, then show corrected or example code. Keep code short.',
  career:
    'You are a career counsellor. Give practical options with pros and cons, and concrete next steps. Do not invent specific college rankings, fees, cut-offs or salaries; say they should be checked on official sites.',
  email:
    "You write clear, professional emails. Output a 'Subject:' line, then the email body, in the requested tone. Use [placeholders] for names or details you were not given.",
  meeting:
    "You plan meetings. Output an agenda with time per item that fits the duration, then a short invite message, then talking points. You cannot see anyone's calendar; never claim to schedule or send anything.",
  summary:
    'You summarise text faithfully in the requested output format. Use only the pasted text; never add facts that are not in it.',
  data:
    'You are a business analyst. If data is provided, base every claim on it and quote the numbers you use. If no data is provided, give general guidance and say what data would be needed. Never invent figures.',
  trip:
    'You are a travel planner. Produce a day-by-day itinerary for the given number of days and style. You have no live information: do not state prices, opening hours or availability as facts; tell the user to check them before travelling.',
  gift:
    'You suggest gifts. Give 5–7 ideas that fit the person, occasion and budget, each with one line on why it fits. You cannot buy or deliver anything.',
};

const AGENTS = DEFINITIONS.map((agent, index) => ({
  ...agent,
  systemPrompt: SYSTEM_PROMPTS[agent.id],
  enabled: true,
  order: index,
}));

module.exports = { GROUPS, AGENTS };
