# SparkIQ design and data flow

## Context flow

`context_0 = { idea }`. For stage `n`, the backend receives `{ stage: n, context: context_(n-1), userInput }`, invokes a stage-specific prompt, validates the request with Zod, and returns one JSON object. The frontend merges the returned object into the context before moving on. The next stage therefore sees all earlier decisions.

## Stage contracts

1. Discover: `{ idea, ideaType, problem, audience, goals[], constraints[], openQuestions[] }`
2. Improve: `{ suggestions: [{ title, reason, impact, accepted }] }`
3. Position: `{ category, differentiator, valueProposition, competitiveAngle, competitors[], debate[] }`
4. Personality: `{ traits: [{ name, reason }], avoidTraits[] }`
5. Naming: `{ names: [{ name, rationale, clicheCheck }], tagline, oneLinePitch, rejectedCliches[], rejectedReasons[] }`
6. Visuals: `{ palette: [{ name, hex }], typography, logoStyle, shapes, imageStyle, avoid[], poster }`
7. Voice: `{ toneRules[], doExamples[], dontExamples[], sampleMessages[] }`
8. Video: `{ duration, scenes: [{ timestamp, visual, voiceover, onScreenText }] }`
9. Launch: `{ landingHeadline, oneLinePitch, instagram, linkedin, ecommerce }`
10. Kit: `{ summary, scores: [{ area, uniqueness, consistency, reason }], autofixes[], consistencyScore }`

## Visual system

The product uses a deep metallic blue base (`#0A1128`), steel/electric blue controls, silver-blue borders, high-contrast text, and restrained lime/apricot signal accents. Space Grotesk is used for display decisions and DM Sans for reading. Poster generation is CSS/HTML rendered to PNG in the browser.