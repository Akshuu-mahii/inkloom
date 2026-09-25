import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

if (!process.env.LLM_API_KEY) {
  console.warn('SparkIQ running in local fallback mode: add LLM_API_KEY to backend/.env for live LLM generation.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const requestSchema = z.object({ stage: z.number().int().min(1).max(10), context: z.record(z.any()).default({}), userInput: z.string().optional() });
const stages = [
  'Discover Questions: return idea, description, ideaType, audience, goals, constraints, and a dynamic discoveryQuestions array of 4-10 brief questions. Always include the four required questions exactly: How did you come up with this idea?, Why this idea?, Who is it for?, What problem does it solve?. Add only the missing-gap questions appropriate to the clarity of the submitted idea. The description must explain the submitted idea in plain language, and include ideaContext on each question.',
  'Idea Improver: return three fresh suggestions with title, reason, impact, changed and whyChanged, accepted=false. Avoid every prior option supplied in context.previousOptions.',
  'Positioning: return category, differentiator, valueProposition, competitiveAngle, competitors, debate with strategist, skeptic and customer messages.',
  'Personality: return traits with justification, avoidTraits, and archetype with a one-line reason. Avoid every prior trait in context.previousOptions.',
  'Name + Tagline: return 4 names with rationale, tagline and oneLinePitch. Detect cliches and reject weak options. If a visual theme exists, match its mood. Avoid every prior name and tagline in context.previousOptions.',
  'Visual Direction: return palette with hex values, readable names, six alternative palettes, typography, logoStyle, shapes, imageStyle, avoid, poster copy, and six distinct posterSuggestions. Avoid prior poster directions in context.previousOptions.',
  'Brand Voice: return toneRules, doExamples, dontExamples, sampleMessages, voiceStyles for audio selection, and reflect context.brandValues.',
  'Video Script: return duration and scenes with timestamp, visual, voiceover and onScreenText, plus an audioTrack fallback description.',
  'Launch Content: return landingHeadline, oneLinePitch, instagram, linkedin and ecommerce guide, reflecting context.brandValues.',
  'Final Brand Kit: return a concise strategy summary, launch plan, scores with reasons, autofixes and consistencyScore.'
];

function seedResult(stage, context, userInput = '') {
  const idea = context.idea || userInput || 'a new venture';
  const lower = idea.toLowerCase();
  const food = /cake|bakery|food|cook|restaurant|bake/.test(lower);
  const decor = /home decor|room decor|wall art|decor/.test(lower);
  const audience = context.audience || (food ? 'people celebrating small, meaningful moments' : decor ? 'homeowners and renters looking for elevated room styling' : 'curious early adopters who value clarity');
  const name = food ? 'Crumb & Candle' : decor ? 'Hearth & Hue' : 'Northstar Signal';
  const palette = food ? [{ name: 'Deep Navy', hex: '#0A1128' }, { name: 'Cobalt Blue', hex: '#2E5EAA' }, { name: 'Silver Mist', hex: '#DDE6F5' }, { name: 'Apricot Glow', hex: '#F2A65A' }] : [{ name: 'Deep Navy', hex: '#0A1128' }, { name: 'Electric Blue', hex: '#3B82F6' }, { name: 'Silver Mist', hex: '#B8C4D9' }, { name: 'Signal Lime', hex: '#B8E05F' }];
  const previous = context.previousOptions || [];
  const base = { stage, generatedAt: new Date().toISOString(), reasoning: 'This recommendation connects the idea, audience, and desired emotional outcome while leaving room to validate market facts.' };
  const round = Number(context.regeneration || 0);
  if (stage === 1) { const detailed = idea.trim().split(/\s+/).length >= 10 && [/\bfor\b/i, /\bto\b/i, /\bfocused on\b/i, /\bin\b/i, /\bwith\b/i].filter(pattern => pattern.test(idea)).length >= 2; const requiredQuestions = ['How did you come up with this idea?', 'Why this idea?', 'Who is it for?', 'What problem does it solve?', 'What are your goals or constraints?']; const optionalQuestions = detailed ? ['What would the first version or offer include?', 'Which competitors or alternatives do people use today?'] : ['What would the first version or offer include?', 'Which competitors or alternatives do people use today?', 'What budget, timeline, or scope do you have in mind?', 'What would make this idea successful in the first three months?']; const questionList = [...requiredQuestions, ...optionalQuestions]; return { ...base, idea, description: `${idea} is an early-stage ${decor ? 'home decor and wall art business' : (food ? 'food business' : 'product or service')} idea focused on creating a clear, useful experience for a specific audience. The first version should stay narrow enough to test, learn from real people, and improve before expanding.`, ideaType: decor ? 'home decor / room decor' : (food ? 'food business' : 'product or service'), audience, goals: ['Validate demand', 'Earn repeat customers', 'Launch with a distinct point of view'], constraints: ['Small initial budget', 'Need proof before scaling'], discoveryQuestions: questionList.map((question, index) => ({ question, required: index < requiredQuestions.length, ideaContext: `Answer briefly with the submitted idea in mind: “${idea}”`, answer: context.discoveryAnswers?.[question] || '', placeholder: 'In a sentence or two...' })), openQuestions: ['What is the first offer?', 'Which moment makes someone choose you?'], questionMode: detailed ? 'focused' : 'deep discovery' }; }
  if (stage === 2) { const rounds = [['Name the first use case', 'Choose a signature detail', 'Start with a narrow promise'], ['Package one celebration moment', 'Make the ordering ritual memorable', 'Test one premium proof point'], ['Own the birthday milestone', 'Turn customization into a signature', 'Build a referral-first launch']]; const titles = rounds[round % rounds.length]; return { ...base, suggestions: titles.map((title, index) => ({ title, reason: ['A concrete first moment makes the idea easier to test and remember.', 'One repeatable detail can become a recognizable brand asset.', 'Focus creates proof faster than trying to serve everyone.'][index], impact: ['Higher conversion', 'Stronger recall', 'Faster learning'][index], changed: round ? `Fresh alternative round ${round}` : 'Original direction', whyChanged: userInput && userInput !== idea ? `Refined around your direction: ${userInput}` : 'Grounded in the current audience and promise.', accepted: false })) }; }
  if (stage === 3) return { ...base, category: food ? 'celebration bakery' : 'trust-first digital tools', differentiator: food ? 'Small-batch cakes designed around the story of the celebration.' : 'Clear, calm tools that turn uncertainty into an actionable signal.', valueProposition: `For ${audience}, ${name} makes the important choice feel considered, simple, and worth sharing.`, competitiveAngle: 'Own the specific moment, not the whole market.', competitors: [{ name: 'Local alternative', status: 'AI-suggested, please verify' }, { name: 'Established category leader', status: 'AI-suggested, please verify' }, { name: 'DIY option', status: 'AI-suggested, please verify' }], debate: [{ agent: 'Strategist', message: 'Lead with a focused promise and a distinctive proof point.' }, { agent: 'Skeptic', message: 'The promise needs customer interviews and competitor verification before being treated as fact.' }, { agent: 'Customer', message: 'I want to understand quickly why this was made for my situation.' }] };
  if (stage === 4) { const traitRounds = [['Warm', 'Crisp', 'Generous'], ['Thoughtful', 'Playful', 'Reliable'], ['Inviting', 'Crafted', 'Bright']]; const selected = traitRounds[round % traitRounds.length]; return { ...base, traits: selected.map((item, index) => ({ name: item, reason: ['Makes the experience feel human.', 'Protects clarity when choices matter.', 'Turns customers into participants.'][index], rank: index + 1 })), archetype: { name: food ? 'The Caregiver' : 'The Sage', reason: 'It fits an audience looking for thoughtful help without pressure.' }, brandValues: food ? [{ name: 'Reliability', reason: 'Birthday customers need the cake and delivery to arrive as promised.' }, { name: 'Care', reason: 'Thoughtful details make a celebration feel personal.' }, { name: 'Joy', reason: 'The audience is buying an experience worth remembering.' }] : [{ name: 'Clarity', reason: 'People need confidence when choosing a new solution.' }, { name: 'Trust', reason: 'Reliable guidance lowers decision anxiety.' }, { name: 'Progress', reason: 'Small steps help the audience move forward.' }], avoidTraits: ['Corporate', 'Overly polished', 'Urgent or fear-driven'] }; }
  if (stage === 5) {
    const detectBusinessProfile = (inputIdea, ctx = {}) => {
      const text = `${inputIdea || ''} ${ctx.ideaType || ''} ${ctx.category || ''} ${ctx.audience || ''} ${ctx.valueProposition || ''}`.toLowerCase();
      const rules = [
        { type: 'home', label: 'home decor / lifestyle', style: 'crafted, elevated, calming', personality: 'warm and design-aware', keywords: ['home decor', 'room decor', 'wall art', 'interior', 'decor', 'furniture', 'lifestyle', 'room styling', 'home styling', 'living room', 'home'] },
        { type: 'food', label: 'food & bakery', style: 'warm, sensory, celebratory', personality: 'friendly and comforting', keywords: ['birthday cake', 'cake', 'bakery', 'food', 'cook', 'restaurant', 'bake', 'dessert', 'catering', 'coffee', 'tea', 'meal', 'celebration'] },
        { type: 'education', label: 'education / creator', style: 'playful, warm, memorable', personality: 'approachable and encouraging', keywords: ['youtube channel', 'kids', 'children', 'education', 'learning', 'course', 'youtube', 'channel', 'coding', 'school', 'tutor', 'class', 'teaching'] },
        { type: 'tech', label: 'tech / software', style: 'clean, modern, intelligent', personality: 'clear and credible', keywords: ['software', 'app', 'platform', 'saas', 'dashboard', 'automation', 'ai', 'analytics', 'tool', 'tech', 'startup', 'product'] },
        { type: 'b2b', label: 'professional services', style: 'trustworthy, strategic, precise', personality: 'confident and dependable', keywords: ['accounting', 'business', 'agency', 'consulting', 'finance', 'legal', 'hr', 'operations', 'b2b', 'professional', 'service'] },
        { type: 'fashion', label: 'fashion / beauty', style: 'elegant, expressive, aspirational', personality: 'stylish and premium', keywords: ['fashion', 'beauty', 'jewelry', 'makeup', 'skincare', 'boutique', 'luxury', 'wardrobe', 'apparel', 'style'] },
        { type: 'community', label: 'community / impact', style: 'purpose-driven, inclusive, rooted', personality: 'human and hopeful', keywords: ['community', 'nonprofit', 'support', 'impact', 'local', 'network', 'volunteer', 'foundation', 'membership'] },
        { type: 'health', label: 'health / wellness', style: 'supportive, uplifting, grounded', personality: 'calm and empowering', keywords: ['health', 'wellness', 'fitness', 'therapy', 'clinic', 'care', 'wellbeing', 'med', 'mental health', 'exercise'] }
      ];

      let winner = { type: 'general', label: 'general brand', style: 'versatile, clear, distinctive', personality: 'balanced and memorable', score: 0 };
      for (const rule of rules) {
        const score = rule.keywords.reduce((total, keyword) => {
          if (!text.includes(keyword)) return total;
          const weight = keyword.includes(' ') ? 5 : 2;
          return total + weight;
        }, 0);

        if (score > winner.score) {
          winner = { ...rule, score };
        }
      }

      return winner.type === 'general' ? { type: 'general', label: 'general brand', style: 'versatile, clear, distinctive', personality: 'balanced and memorable' } : winner;
    };

    const profile = detectBusinessProfile(idea, context);
    const namingSets = {
      food: [
        [
          { name: 'Honey & Crumb', technique: 'evocative', rationale: 'Warm, sensory, and celebration-first without sounding like a default bakery template.', clicheCheck: 'Low risk: avoids generic pastry language and keeps the mood personal.' },
          { name: 'Gather Table', technique: 'descriptive', rationale: 'Feels like a real gathering brand and clearly reflects a hospitality or celebration offer.', clicheCheck: 'Low risk: clear and memorable without relying on overused “bakes” language.' },
          { name: 'Golden Hollow', technique: 'metaphor', rationale: 'Feels premium and artisanal while staying distinctive and not template-like.', clicheCheck: 'Low risk: crafted and memorable without a tired “sweet” label.' },
          { name: 'Cinder & Kind', technique: 'blended', rationale: 'Adds warmth and character, making it feel handcrafted and community-centered.', clicheCheck: 'Low risk: original enough to feel owned rather than generic.' }
        ],
        [
          { name: 'Sunlit Crumb', technique: 'evocative', rationale: 'A friendly, bright name that fits a food brand and projects warmth to customers.', clicheCheck: 'Low risk: natural and distinctive, not another generic dessert label.' },
          { name: 'Cake & Kind', technique: 'descriptive', rationale: 'Clear for a celebration business and easy for people to remember quickly.', clicheCheck: 'Low risk: simple but grounded in generosity rather than cliché sales language.' },
          { name: 'Amber Gather', technique: 'metaphor', rationale: 'Suggests a thoughtful, uplifting experience that suits celebrations and gifting.', clicheCheck: 'Low risk: cohesive and premium without sounding like a stock bakery name.' },
          { name: 'Maple Loom', technique: 'blended', rationale: 'Feels artisanal and modern while still fitting a warm hospitality brand.', clicheCheck: 'Low risk: original, memorable, and not built around “best” or “delicious” clichés.' }
        ]
      ],
      tech: [
        [
          { name: 'Northstack', technique: 'blended', rationale: 'Strong, modern, and technical without sounding like a copy-paste SaaS startup name.', clicheCheck: 'Low risk: it carries clarity and momentum without “labs” or “solutions” filler.' },
          { name: 'Ledgerly', technique: 'blended', rationale: 'Easy to recognize, professional, and aligned with a practical product or platform.', clicheCheck: 'Low risk: credible without leaning into familiar startup jargon.' },
          { name: 'Signal Forge', technique: 'metaphor', rationale: 'Feels focused and high-trust, which suits a product made to remove friction.', clicheCheck: 'Low risk: strong and memorable instead of generic “AI” naming.' },
          { name: 'Helio Ledger', technique: 'descriptive', rationale: 'Combines credibility with modern energy for a product or service built to simplify work.', clicheCheck: 'Low risk: clear and professional without sounding overly corporate.' }
        ],
        [
          { name: 'StrideFlow', technique: 'blended', rationale: 'Feels active and polished, which works for a product that helps people move faster.', clicheCheck: 'Low risk: technical enough to feel credible without becoming a cliché startup label.' },
          { name: 'Fieldnote', technique: 'descriptive', rationale: 'Reads like an elegant software tool that is useful and easy to talk about.', clicheCheck: 'Low risk: distinct and usable without the usual “cloud” or “hub” formula.' },
          { name: 'Clear Harbor', technique: 'metaphor', rationale: 'Matches a calm, trustworthy product brand built to reduce uncertainty.', clicheCheck: 'Low risk: polished and straightforward without bland SaaS conventions.' },
          { name: 'Beam & Co.', technique: 'founder-style', rationale: 'Feels credible and human, which works for a product or service-led brand.', clicheCheck: 'Low risk: approachable and memorable instead of a stock software template.' }
        ]
      ],
      fashion: [
        [
          { name: 'Veloura', technique: 'blended', rationale: 'Elegant and expressive, with enough softness to fit beauty or boutique fashion.', clicheCheck: 'Low risk: premium feeling without leaning on generic luxury clichés.' },
          { name: 'Maison Lune', technique: 'founder-style', rationale: 'Feels elevated and distinctive, suited to apparel, beauty, or lifestyle brands.', clicheCheck: 'Low risk: refined and memorable without a pile of luxury buzzwords.' },
          { name: 'Silk & Sable', technique: 'evocative', rationale: 'Captures mood and premium styling without sounding like a cliché beauty label.', clicheCheck: 'Low risk: textured and stylish, not overused or empty.' },
          { name: 'Asterform', technique: 'metaphor', rationale: 'Modern and expressive, with enough shape to fit design-led retail or beauty.', clicheCheck: 'Low risk: original and brandable rather than a generic fashion formula.' }
        ],
        [
          { name: 'Serein Studio', technique: 'descriptive', rationale: 'A clean boutique feel that works well for modern fashion or beauty offers.', clicheCheck: 'Low risk: premium and polished without a cliché luxury script.' },
          { name: 'Lark & Loom', technique: 'evocative', rationale: 'Warm, tactile, and memorable for a lifestyle or apparel brand.', clicheCheck: 'Low risk: atmospheric and distinct, not another recycled luxury word list.' },
          { name: 'Velvet Ember', technique: 'metaphor', rationale: 'A strong visual identity for a beauty or fashion brand with emotional pull.', clicheCheck: 'Low risk: expressive and memorable, not a stock “luxury” name.' },
          { name: 'Vale & Form', technique: 'blended', rationale: 'Feels intentional and elevated without losing accessibility and clarity.', clicheCheck: 'Low risk: premium but not generic.' }
        ]
      ],
      education: [
        [
          { name: 'CodeSprout', technique: 'blended', rationale: 'Friendly and memorable for a learning brand with a playful, growth-focused feel.', clicheCheck: 'Low risk: it feels creative without turning into a toy-brand cliché.' },
          { name: 'Little Loop', technique: 'descriptive', rationale: 'Easy for kids and parents to remember while still feeling creative and bright.', clicheCheck: 'Low risk: approachable and not another stock ed-tech template.' },
          { name: 'Bright Byte', technique: 'evocative', rationale: 'Works well for a creator or coding audience that values clarity and curiosity.', clicheCheck: 'Low risk: visual and memorable without the normal “learn with us” trope.' },
          { name: 'Camp Curious', technique: 'metaphor', rationale: 'Feels exploratory and welcoming, which suits education and discovery-led content.', clicheCheck: 'Low risk: child-friendly and specific instead of generic.' }
        ],
        [
          { name: 'Tiny Tinker', technique: 'descriptive', rationale: 'Feels playful and accessible for a kids-focused or beginner-friendly educational brand.', clicheCheck: 'Low risk: simple and charming, not a preachy school name.' },
          { name: 'Playbyte', technique: 'blended', rationale: 'Strong fit for kids, coding, or digital learning without sounding too formulaic.', clicheCheck: 'Low risk: energetic and brandable, not a standard “academy” label.' },
          { name: 'Wonder Loop', technique: 'evocative', rationale: 'A warm and curious brand name that supports learning and creative exploration.', clicheCheck: 'Low risk: imaginative and memorable without becoming cliché.' },
          { name: 'Sprout & Script', technique: 'metaphor', rationale: 'Excellent for a creative learning brand that balances fun and skill building.', clicheCheck: 'Low risk: thoughtful and distinctive rather than generic.' }
        ]
      ],
      b2b: [
        [
          { name: 'Northlane', technique: 'blended', rationale: 'Professional and memorable without the usual consulting or corporate monotony.', clicheCheck: 'Low risk: confident and strategic without the word “solutions” trap.' },
          { name: 'Clear Ledger', technique: 'descriptive', rationale: 'Fits accounting, finance, or ops-focused businesses that value trust and clarity.', clicheCheck: 'Low risk: direct and credible rather than bland.' },
          { name: 'Summit Row', technique: 'metaphor', rationale: 'Signals movement and confidence, which suits a strategic professional service.', clicheCheck: 'Low risk: polished and memorable without sounding corporate-for-corporate’s-sake.' },
          { name: 'Harbor Advisory', technique: 'descriptive', rationale: 'Feels stable and trustworthy for consulting, finance, or operational guidance.', clicheCheck: 'Low risk: mature and specific, not another “group” label.' }
        ],
        [
          { name: 'Signal Harbor', technique: 'evocative', rationale: 'Works well for a serious industry brand that still needs warmth and approachability.', clicheCheck: 'Low risk: practical and trustworthy instead of generic B2B filler.' },
          { name: 'Prime Ledger', technique: 'descriptive', rationale: 'Feels precise and finance-ready without feeling cold or sterile.', clicheCheck: 'Low risk: clear and credible, not a recycled agency name.' },
          { name: 'Aster Works', technique: 'founder-style', rationale: 'Strong and simple enough for a professional services or software business.', clicheCheck: 'Low risk: modern and credible without falling into cliches.' },
          { name: 'Verve Ledger', technique: 'blended', rationale: 'Pairs confidence with clarity, which works for service-heavy B2B brands.', clicheCheck: 'Low risk: memorable and differentiated instead of template-like.' }
        ]
      ],
      home: [
        [
          { name: 'Hearth & Hue', technique: 'evocative', rationale: 'A natural fit for home decor and design-led products with warmth and personality.', clicheCheck: 'Low risk: it feels elevated and lived-in, not like a generic furniture label.' },
          { name: 'Stillroom', technique: 'blended', rationale: 'Perfect for a home or interior brand that wants calm, texture, and character.', clicheCheck: 'Low risk: memorable and design-led instead of formulaic.' },
          { name: 'Velvet Nook', technique: 'descriptive', rationale: 'Works beautifully for decor or wall-art brands with a warm, lifestyle feel.', clicheCheck: 'Low risk: cozy and clear without sounding mass-market.' },
          { name: 'Fern & Frame', technique: 'metaphor', rationale: 'Feels refined and residential, ideal for an interior or wall-art brand.', clicheCheck: 'Low risk: stylish and distinctive without cliché home-goods wording.' }
        ],
        [
          { name: 'Luma Nest', technique: 'blended', rationale: 'Balances a premium visual mood with a strong home-lifestyle signal.', clicheCheck: 'Low risk: aspirational and modern, not a stock decor brand name.' },
          { name: 'Thread & Tone', technique: 'evocative', rationale: 'A natural fit for design-forward decor or curated home products.', clicheCheck: 'Low risk: tactile and memorable rather than generic.' },
          { name: 'Kindred Wall', technique: 'descriptive', rationale: 'Works especially well for wall art, interiors, and room styling offers.', clicheCheck: 'Low risk: clear, warm, and not another broad lifestyle label.' },
          { name: 'Stone & Bloom', technique: 'metaphor', rationale: 'Strong for brands that mix elevated style with emotional comfort and beauty.', clicheCheck: 'Low risk: distinctive and premium without a cutesy shelf-brand tone.' }
        ]
      ],
      community: [
        [
          { name: 'Root & Rise', technique: 'metaphor', rationale: 'Captures progress and purpose, which fits mission-driven or community brands.', clicheCheck: 'Low risk: grounded and hopeful, without an overplayed nonprofit tone.' },
          { name: 'Kindred Circle', technique: 'descriptive', rationale: 'Good for community and support-focused brands that want warmth and belonging.', clicheCheck: 'Low risk: clear and human rather than institutional or stale.' },
          { name: 'Anchor Path', technique: 'metaphor', rationale: 'A strong choice for impact and guidance initiatives with a clear sense of direction.', clicheCheck: 'Low risk: purposeful and memorable, not generic.' },
          { name: 'Open Hearth', technique: 'evocative', rationale: 'Feels warm and welcoming while still feeling confident and credible.', clicheCheck: 'Low risk: community-first without cliché charity language.' }
        ],
        [
          { name: 'Common Thread', technique: 'descriptive', rationale: 'Especially strong for community, network, and mission-led brands that connect people.', clicheCheck: 'Low risk: warm and clear without sounding like a typical nonprofit label.' },
          { name: 'Gather North', technique: 'evocative', rationale: 'Feels uplifting and collective, ideal for brands built around people and momentum.', clicheCheck: 'Low risk: memorable and grounded rather than cliché.' },
          { name: 'Bright Harbor', technique: 'metaphor', rationale: 'Signals stability and welcome, which suits purpose-driven brands well.', clicheCheck: 'Low risk: strong and useful enough to own.' },
          { name: 'Rise & Root', technique: 'founder-style', rationale: 'Flexible and human, with enough character to fit a community or social brand.', clicheCheck: 'Low risk: optimistic and rooted without sounding generic.' }
        ]
      ],
      health: [
        [
          { name: 'Bloom Harbor', technique: 'evocative', rationale: 'Matches wellness and care brands that need calm, trust, and uplifting energy.', clicheCheck: 'Low risk: supportive and distinctive instead of a tired wellness cliché.' },
          { name: 'Purestride', technique: 'blended', rationale: 'Feels clean and active, ideal for health, movement, or wellbeing brands.', clicheCheck: 'Low risk: polished and modern without sounding like a generic gym name.' },
          { name: 'Lift & Lean', technique: 'descriptive', rationale: 'Strong for a health or coaching business focused on sustainable progress.', clicheCheck: 'Low risk: clear and motivating without cliché fitness language.' },
          { name: 'Kind Motion', technique: 'metaphor', rationale: 'A gentle, professional fit for wellness or care-focused offerings.', clicheCheck: 'Low risk: uplifting and memorable without a sterile clinical tone.' }
        ],
        [
          { name: 'Motive Mind', technique: 'descriptive', rationale: 'Works for coaching, mental health, or personal growth brands with a supportive voice.', clicheCheck: 'Low risk: warm, practical, and not another generic self-care brand.' },
          { name: 'Well & Wild', technique: 'evocative', rationale: 'Good for health or lifestyle brands that want to feel natural and human.', clicheCheck: 'Low risk: more distinctive than the usual wellness label set.' },
          { name: 'Beacon Body', technique: 'metaphor', rationale: 'Signals trust, guidance, and movement in a wellness or fitness environment.', clicheCheck: 'Low risk: strong and modern without becoming formulaic.' },
          { name: 'North Pulse', technique: 'blended', rationale: 'High-energy and memorable for a health or performance-focused brand.', clicheCheck: 'Low risk: clear and active rather than generic gym-brand language.' }
        ]
      ],
      general: [
        [
          { name: 'Northlane', technique: 'blended', rationale: 'Flexible and memorable across categories, helping businesses feel distinctive instead of generic.', clicheCheck: 'Low risk: it feels polished and adaptable without forced niche cues.' },
          { name: 'Common Thread', technique: 'descriptive', rationale: 'Clear, memorable, and broad enough to work for many kinds of businesses.', clicheCheck: 'Low risk: grounded and human, not a tired category cliché.' },
          { name: 'Field & Form', technique: 'metaphor', rationale: 'Good for a broad-range brand that wants a professional, thoughtful identity.', clicheCheck: 'Low risk: modern and confident without sounding template-made.' },
          { name: 'Hollow & Co.', technique: 'founder-style', rationale: 'Simple and credible, making it suitable for versatile brand positioning.', clicheCheck: 'Low risk: personal, memorable, and not based on empty buzzwords.' }
        ],
        [
          { name: 'Verve Harbor', technique: 'evocative', rationale: 'Balanced and broad, which lets it feel premium and versatile across industries.', clicheCheck: 'Low risk: distinctive and smooth rather than generic.' },
          { name: 'True North', technique: 'metaphor', rationale: 'Timeless and versatile, suited to a company that wants trust and clarity.', clicheCheck: 'Low risk: broad enough to work without sounding like a default template.' },
          { name: 'Luma Frame', technique: 'blended', rationale: 'An adaptable, modern brand name that feels considered and visually strong.', clicheCheck: 'Low risk: more distinctive than a generic “solutions” or “labs” style brand.' },
          { name: 'Harbor & Pine', technique: 'evocative', rationale: 'Grounded, memorable, and flexible enough to suit a wide range of brands.', clicheCheck: 'Low risk: it avoids broad cliché territory while staying accessible.' }
        ]
      ]
    };

    const sets = namingSets[profile.type] || namingSets.general;
    const names = (sets[round % sets.length] || sets[0]).map(item => ({
      name: item.name,
      rationale: item.rationale,
      technique: item.technique,
      clicheCheck: item.clicheCheck
    }));

    const taglines = {
      food: ['Make the moment delicious.', 'Bake a little more joy.', 'A beautiful reason to gather.'],
      tech: ['Built for clearer decisions.', 'Simple tools. Strong momentum.', 'Make the signal sharper.'],
      fashion: ['Wear the feeling.', 'Style that settles in.', 'Make your mood visible.'],
      education: ['Learn with delight.', 'Small wins, big curiosity.', 'Make room for wonder.'],
      b2b: ['Clarity that earns trust.', 'Keep work moving clearly.', 'Build confidence into every decision.'],
      home: ['Design the room you want to live in.', 'Bring calm to the corners that matter.', 'A more considered place to be.'],
      community: ['Create belonging in action.', 'A stronger place to gather.', 'Build momentum together.'],
      health: ['Feel stronger, calmer, more supported.', 'Build better routines.', 'Move with confidence.'],
      general: ['Choose what feels true.', 'Make the next step easier.', 'A brand built to be remembered.']
    };

    return {
      ...base,
      names,
      tagline: (taglines[profile.type] || taglines.general)[round % (taglines[profile.type] || taglines.general).length],
      oneLinePitch: `A ${profile.label} brand built for ${audience} with a ${profile.style} tone and a ${profile.personality} personality.`,
      rejectedCliches: ['Best', 'Hub', 'Solutions', 'NextGen', 'Fresh'],
      rejectedReasons: ['Overused, thinly differentiated, or too generic for the intended business type.']
    };
  }
  if (stage === 6) { const poster = { eyebrow: food ? 'SMALL BATCH / BIG MOMENTS' : 'A CLEAR SIGNAL', headline: context.name || name, subhead: food ? 'Make the moment delicious.' : 'Make the next move clearer.' }; const palettes = [palette, [{ name: 'Steel Blue', hex: '#172B4D' }, { name: 'Sky Signal', hex: '#6EA8FF' }, { name: 'Cloud White', hex: '#F0F4FA' }, { name: 'Coral Spark', hex: '#FF8364' }], [{ name: 'Ink Blue', hex: '#081526' }, { name: 'Royal Blue', hex: '#4267B2' }, { name: 'Frost', hex: '#C9D7EA' }, { name: 'Honey Accent', hex: '#E8B04E' }], [{ name: 'Harbor Blue', hex: '#12304A' }, { name: 'Mist Blue', hex: '#76A9C2' }, { name: 'Pearl', hex: '#E8EEF2' }, { name: 'Copper Light', hex: '#C9825A' }], [{ name: 'Night Steel', hex: '#101A2B' }, { name: 'Blue Steel', hex: '#405D7A' }, { name: 'Silver', hex: '#CBD5E1' }, { name: 'Ice Glow', hex: '#A7D8F0' }], [{ name: 'Royal Navy', hex: '#14213D' }, { name: 'Bright Cobalt', hex: '#2774E6' }, { name: 'Moon Silver', hex: '#D6E0ED' }, { name: 'Lime Signal', hex: '#B6D957' }]]; const chosenPalette = context.selectedPalette || palettes[round % palettes.length]; return { ...base, palette: chosenPalette, palettes: palettes.map((colors, index) => ({ id: String.fromCharCode(65 + index), name: `Palette ${String.fromCharCode(65 + index)}: ${['Midnight Steel', 'Ocean Breeze', 'Ink & Honey', 'Harbor Mist', 'Night Silver', 'Royal Signal'][index]}`, colors })), typography: { display: 'Space Grotesk', body: 'DM Sans' }, logoStyle: 'A compact wordmark with one precise spark or notch.', shapes: 'Rounded capsules paired with one sharp diagonal accent.', imageStyle: 'Close, tactile, natural light; show the real product or moment.', avoid: ['Stock-smile imagery', 'Overloaded gradients', 'Generic swooshes'], poster, posterStyle: context.posterStyle || 'minimal', posterSuggestions: [1, 2, 3, 4, 5, 6].map(number => ({ id: number, label: `Suggestion ${number}`, layout: `${['editorial', 'bold', 'gallery', 'side-aligned', 'pattern', 'icon-led'][number - 1]} variant ${round + 1}`, palette: chosenPalette, poster: { ...poster, eyebrow: `${poster.eyebrow} / ${(context.posterStyle || 'minimal').toUpperCase()} / ${number} / ${round + 1}` } })) }; }
  if (stage === 7) return { ...base, toneRules: ['Be warm before clever.', 'Use short concrete sentences.', 'Invite rather than pressure.'], doExamples: ['Your cake is ready for its big entrance.', 'Here is the clearest next step.'], dontExamples: ['We disrupt the industry.', 'Act now before it is too late.'], sampleMessages: ['A little spark for your big moment.', 'Made thoughtfully. Delivered simply.', 'Want to make this yours?'], valueMessages: context.brandValues?.map(value => `${value.name}: ${value.reason}`) || [], voiceStyles: [
      { name: 'Warm Female', description: 'Soft, welcoming, and quietly persuasive.', sample: 'A little spark can make the whole experience feel personal.' },
      { name: 'Confident Male', description: 'Clear, premium, and credible.', sample: 'This is a clear, credible point of view that earns trust quickly.' },
      { name: 'Energetic Youth', description: 'Fresh, upbeat, and magnetic.', sample: 'Fresh, bold, and built to stand out without the noise.' },
      { name: 'Calm Narrator', description: 'Thoughtful and steady.', sample: 'A thoughtful brand starts with clarity and a steady promise.' },
      { name: 'Friendly Casual', description: 'Warm and easygoing.', sample: 'Simple, warm, and easy to remember from the first moment.' },
      { name: 'Professional Formal', description: 'Polished and precise.', sample: 'This brand helps people make confident decisions with less friction.' },
      { name: 'Deep Authoritative', description: 'Strong and assured.', sample: 'Presence, clarity, and conviction are what make a brand stick.' },
      { name: 'Bright Cheerful', description: 'Playful and optimistic.', sample: 'Make the next step feel as good as the idea behind it.' }
    ] };
  if (stage === 8) {
    const wallArt = /home decor|room decor|wall art|decor/.test(lower);
    const roomScene = wallArt ? { visual: 'A layered room vignette with sculptural wall art and one statement accent.', voiceover: 'The room should feel considered, not crowded. Every piece earns its place.', onScreenText: 'Designed for the room' } : { visual: 'A close-up of the first meaningful detail.', voiceover: 'Every good idea starts with a moment worth making better.', onScreenText: name };
    return { ...base, duration: wallArt ? '40 seconds' : '45 seconds', scenes: [
      { timestamp: '0-06s', ...roomScene },
      { timestamp: '06-20s', visual: wallArt ? 'A styled wall-art display in a bedroom or living area.' : 'Founder shaping the offer for a real person.', voiceover: wallArt ? 'Built for a room, a mood, and a moment people notice on entry.' : `That is why ${name} focuses on the detail others rush past.`, onScreenText: wallArt ? 'Room-ready styling' : 'Made for the moment' },
      { timestamp: '20-34s', visual: wallArt ? 'Close-up of tactile textures and layered neutrals for the wall display.' : 'Customer experiencing the result.', voiceover: wallArt ? 'Curated pieces should feel personal, elevated, and easy to live with.' : 'Simple to choose. Memorable to receive.', onScreenText: wallArt ? 'Easy to style' : 'Make it count' },
      { timestamp: '34-40s', visual: 'Wordmark and invitation.', voiceover: wallArt ? 'Bring more beauty, less clutter, and a stronger sense of home.' : 'Make the next moment yours.', onScreenText: wallArt ? 'Make it feel like home.' : (food ? 'Make the moment delicious.' : 'Make the next move clearer.') }
    ], audioTrack: { status: 'ready', label: 'Script-synced voice-over audio track', voice: context.voiceStyle || 'Warm Female', note: 'Full visual video generation is a stretch feature; this audio track is ready for the script scenes.' } };
  }
  if (stage === 9) {
    const homeDecor = /home decor|room decor|wall art|decor/.test(lower);
    const ecommerce = homeDecor ? {
      type: 'home decor / room decor',
      channel: 'Launch on Etsy, Shopify, and Pinterest with a room-by-room editorial feed',
      listingTitle: `${context.name || name} wall art for ${context.roomType || 'bedroom'} spaces`,
      description: 'Thoughtful wall art and companion decor pieces designed to bring warmth, clarity, and personality into a room without visual clutter.',
      keywords: ['wall art', 'room decor', 'home styling', 'sculptural prints'],
      steps: ['Test a first set of 6-12 wall-art pieces in one room story', 'Collect feedback on scale and price', 'Then expand to bundles and seasonal drops'],
      roomType: context.roomType || 'Bedroom',
      roomSize: context.roomSize || 'Medium (100-200 sq ft)'
    } : food ? { channel: 'Test on Zepto or Blinkit after offline validation', listingTitle: `${name} celebration cakes`, description: 'Small-batch cakes made with care for the moments people remember.', keywords: ['birthday cake', 'small batch', 'celebration'], steps: ['Test the offer offline', 'Collect repeatable feedback', 'Then list online'] } : null;
    return { ...base, landingHeadline: homeDecor ? 'Curated wall art for rooms that need character.' : (food ? 'Celebration, baked around you.' : 'Clarity for the move that matters.'), oneLinePitch: homeDecor ? 'Thoughtful wall art and room styling for people who want their space to feel more personal.' : (food ? 'Small-batch cakes with a story in every detail.' : 'Focused intelligence for people building what is next.'), instagram: `Made for ${homeDecor ? 'living spaces and beautiful moments at home' : (context.brandValues?.map(value => value.name.toLowerCase()).join(', ') || 'care and clarity')}. A small spark can change the whole moment.`, linkedin: `Our launch is guided by ${context.brandValues?.map(value => value.name.toLowerCase()).join(', ') || 'care and clarity'}: a considered way to move from idea to action.`, ecommerce };
  }
  return { ...base, summary: `${name} is a focused brand for ${audience}.`, scores: [{ area: 'Name', uniqueness: 8, consistency: 9, reason: 'Distinctive image and aligned with the promise.' }, { area: 'Tagline', uniqueness: 8, consistency: 9, reason: 'Short, active, and emotionally specific.' }, { area: 'Logo direction', uniqueness: 7, consistency: 8, reason: 'Strong direction; logo uniqueness is an AI estimate, not a guarantee.' }, { area: 'Voice', uniqueness: 8, consistency: 9, reason: 'Warm clarity matches the audience.' }, { area: 'Visuals', uniqueness: 8, consistency: 9, reason: 'The palette balances trust with an owned accent.' }], autofixes: [], consistencyScore: 8.6 };
}

async function callModel(stage, context, userInput) {
  if (!process.env.LLM_API_KEY) {
    throw new Error('LLM is not configured; the app is using the local fallback generator.');
  }
  const prompt = `You are SparkIQ's ${stages[stage - 1]} Return ONLY valid JSON matching the requested structure. Use all prior brand context. Never invent competitor facts; mark suggestions for verification. Context: ${JSON.stringify(context)} User input: ${userInput || ''}`;
  const response = await fetch(`${process.env.LLM_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` }, body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4o-mini', temperature: 0.7, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You produce structured brand strategy JSON.' }, { role: 'user', content: prompt }] }) });
  if (!response.ok) throw new Error(`LLM request failed (${response.status})`);
  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, provider: process.env.LLM_MODEL || 'configured model' }));
app.post('/api/stage', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'stage, context, and userInput are required' });
  const { stage, context, userInput } = parsed.data;
  try { return res.json({ data: await callModel(stage, context, userInput), source: 'llm' }); }
  catch (error) { return res.json({ data: seedResult(stage, context, userInput), source: 'local-fallback', warning: error.message }); }
});
app.post('/api/chat', async (req, res) => {
  const { message, context = {} } = req.body;
  try {
    const answer = await callModel(1, context, `Founder question: ${message || 'How do I begin?'} Answer as a concise, practical branding coach. Do not return JSON.`);
    return res.json({ answer: typeof answer === 'string' ? answer : JSON.stringify(answer) });
  } catch {
    return res.json({ answer: `Based on your current direction, keep the next decision focused on ${context.audience || 'a specific audience'} and test one promise in the real world. Your question was: “${message || 'How do I begin?'}”` });
  }
});
app.post('/api/share', (req, res) => res.json({ id: crypto.randomUUID(), url: 'http://localhost:5173/share/demo-brand-kit' }));

const port = Number(process.env.PORT || 4000);

function listenOnPort(candidatePort) {
  const server = app.listen(candidatePort, () => {
    console.log(`SparkIQ backend listening on http://localhost:${candidatePort}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = candidatePort + 1;
      console.warn(`Port ${candidatePort} is busy. Retrying on http://localhost:${nextPort}`);
      listenOnPort(nextPort);
      return;
    }

    throw error;
  });
}

listenOnPort(port);