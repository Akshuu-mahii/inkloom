import React, { useEffect, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Check, Download, Edit3, FileText, HelpCircle, MessageCircle, RefreshCw, Send, Sparkles, Volume2, X } from 'lucide-react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import './styles.css';

function SparkLogo({ compact = false, className = '' }) {
  const gradientId = useId().replace(/:/g, '');
  const glowId = `${gradientId}-glow`;
  const edgeId = `${gradientId}-edge`;

  return (
    <svg className={`brand-mark ${className}`.trim()} viewBox="0 0 64 64" role="img" aria-label="SparkIQ logo" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#ebf2ff" />
          <stop offset="18%" stopColor="#d9e4f9" />
          <stop offset="42%" stopColor="#8fb7ff" />
          <stop offset="62%" stopColor="#4f7ee2" />
          <stop offset="100%" stopColor="#152b4d" />
        </linearGradient>
        <linearGradient id={glowId} x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#fff7cf" />
          <stop offset="35%" stopColor="#dfeaff" />
          <stop offset="100%" stopColor="#8ec5ff" />
        </linearGradient>
        <linearGradient id={edgeId} x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#dfe9ff" />
          <stop offset="100%" stopColor="#7da7e8" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#gradientId)"/>
      <path d="M21 14.5L35.7 14.5L29.4 27.2H38.2L24.8 49.5L27.9 33.1H18.5L21 14.5Z" fill="url(#glowId)" opacity="0.96"/>
      <path d="M19 15.5H36.5L31.2 26.2H39.5L25.8 49.2L28.1 34.2H19.5L19 15.5Z" fill="url(#edgeId)" opacity="0.42"/>
      <path d="M44 18V30.3M42 21.5H52M44 17L49 12M44 17L39 12M44 31.5L49 37M44 31.5L39 37M17 44H31M29 44L24 52M18 44L23 52" stroke="#eaf3ff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" opacity={compact ? 0.88 : 0.9}/>
      <circle cx="44" cy="18" r="2.7" fill="#f5f8ff" opacity="0.95"/>
      <circle cx="44" cy="31.5" r="2.7" fill="#f5f8ff" opacity="0.95"/>
      <circle cx="17" cy="44" r="2.5" fill="#dfeaff" opacity="0.95"/>
      <circle cx="31" cy="44" r="2.5" fill="#dfeaff" opacity="0.95"/>
      <circle cx="24" cy="52" r="2.2" fill="#dfeaff" opacity="0.95"/>
      <circle cx="48" cy="12" r="2.2" fill="#dfeaff" opacity="0.95"/>
      <circle cx="39" cy="12" r="2.2" fill="#dfeaff" opacity="0.95"/>
      <circle cx="49" cy="37" r="2.2" fill="#dfeaff" opacity="0.95"/>
      <circle cx="39" cy="37" r="2.2" fill="#dfeaff" opacity="0.95"/>
    </svg>
  );
}

const stages = ['Discover', 'Sharpen', 'Position', 'Personality', 'Name', 'Visuals', 'Voice', 'Video', 'Launch', 'Kit'];
const exampleIdeas = ['I want to start a home bakery that sells birthday cakes.', 'A cyber security tool for small teams.', 'A YouTube channel teaching easy regional cooking.'];
const requiredDiscoveryQuestions = [
  'How did you come up with this idea?',
  'Why this idea?',
  'Who is it for?',
  'What problem does it solve?',
  'What are your goals or constraints?'
];
const API = '/api';

function pretty(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function mandatoryDiscovery(data) {
  return (data?.discoveryQuestions || []).filter(item => item.required || requiredDiscoveryQuestions.includes(item.question));
}
function optionalDiscovery(data) {
  return (data?.discoveryQuestions || []).filter(item => !item.required && !requiredDiscoveryQuestions.includes(item.question));
}
function allRequiredDiscoveryAnswered(data, answers = {}) {
  return mandatoryDiscovery(data).every(item => String(answers[item.question] || item.answer || '').trim());
}
function Field({ label, children }) { return <div className="field"><span>{label}</span>{children}</div>; }
function Why({ text }) { return <button className="why" title={text}><HelpCircle size={13} /> Why this?</button>; }

function Poster({ data, context }) {
  const poster = data?.poster || {};
  const palette = data?.palette || [{ hex: '#0A1128' }, { hex: '#2E5EAA' }, { hex: '#B8C4D9' }, { hex: '#B8E05F' }];
  return <div id="poster" className="poster" style={{ '--poster-a': palette[0]?.hex, '--poster-b': palette[1]?.hex, '--poster-c': palette[2]?.hex }}><span>{poster.eyebrow || 'A NEW BRAND DIRECTION'}</span><strong>{poster.headline || context.name || 'SparkIQ'}</strong><em>{poster.subhead || context.tagline || 'Make the next move clearer.'}</em><i /></div>;
}

function PaletteGroup({ palette, selected, onSelect }) {
  return <button className={`palette-group ${selected ? 'chosen' : ''}`} onClick={onSelect}><strong>{palette.name}</strong><span>{palette.colors?.map(color => <i key={color.hex} style={{ background: color.hex }} title={color.name} />)}</span><small>{palette.colors?.map(color => color.name).join(' · ')}</small></button>;
}

function App() {
  const [idea, setIdea] = useState('');
  const [stage, setStage] = useState(0);
  const [context, setContext] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState([{ role: 'assistant', text: 'I am here when a brand decision feels fuzzy. Ask me anything.' }]);
  const [chatInput, setChatInput] = useState('');
  const [language, setLanguage] = useState('English');
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [feedback, setFeedback] = useState([]);
  const [themePreference, setThemePreference] = useState('');
  const [discoveryAnswers, setDiscoveryAnswers] = useState({});
  const [customDirection, setCustomDirection] = useState('');
  const [posterStyle, setPosterStyle] = useState('minimal');
  const [posterChoice, setPosterChoice] = useState(1);
  const [voiceStyle, setVoiceStyle] = useState('Warm Female');
  const [audioReady, setAudioReady] = useState(false);
  const [fullKit, setFullKit] = useState(false);
  const [finalLocked, setFinalLocked] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSelection, setCompareSelection] = useState([]);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoGenerating, setVideoGenerating] = useState(false);
  const [roomType, setRoomType] = useState('Bedroom');
  const [roomSize, setRoomSize] = useState('Medium (100-200 sq ft)');
  const [websiteHtml, setWebsiteHtml] = useState('');

  const runStage = async (target = stage, custom = '', contextOverride = null) => {
    setLoading(true); setError(''); setAccepted(false);
    try {
      const requestContext = { ...(contextOverride || context), idea, discoveryAnswers, posterStyle, voiceStyle, previousOptions: target === stage && result ? extractOptions(result) : (contextOverride || context).previousOptions || [] };
      const response = await fetch(`${API}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: target + 1, context: requestContext, userInput: custom || idea })
      });

      let body;
      try {
        const text = await response.text();
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error('The server returned an empty or invalid response. Please try again.');
      }

      if (!response.ok) throw new Error(body?.error || 'The stage request failed.');
      setResult(body.data);
      setContext(prev => ({ ...prev, ...body.data, discoveryAnswers, posterStyle, voiceStyle, previousOptions: requestContext.previousOptions }));
    } catch (e) {
      setError(e.message || 'This stage could not load.');
    } finally {
      setLoading(false);
    }
  };
  const start = (value = idea) => { setIdea(value); setStage(0); setContext({ idea: value, themePreference }); setTimeout(() => runStage(0, value, { idea: value, themePreference }), 0); };
  const resume = () => { const saved = JSON.parse(localStorage.getItem('sparkiq-progress') || '{}'); if (!saved.idea) return; setIdea(saved.idea); setStage(saved.stage || 0); setContext(saved.context || {}); setResult(saved.result || null); setDiscoveryAnswers(saved.discoveryAnswers || {}); setPosterStyle(saved.posterStyle || ''); setVoiceStyle(saved.voiceStyle || 'Warm Female'); };
  useEffect(() => { if (stage > 0 && !result) runStage(stage); }, [stage]);
  useEffect(() => { if (idea) { localStorage.setItem('sparkiq-progress', JSON.stringify({ idea, stage, context, result, discoveryAnswers, posterStyle, voiceStyle })); setResumeAvailable(true); } }, [idea, stage, context, result, discoveryAnswers, posterStyle, voiceStyle]);
  useEffect(() => { setResumeAvailable(Boolean(localStorage.getItem('sparkiq-progress'))); }, []);
  const next = () => { if (stage === 0) { const mandatory = mandatoryDiscovery(result); if (!allRequiredDiscoveryAnswered(result, discoveryAnswers)) { setError(`Please answer all ${mandatory.length} required discovery questions before continuing.`); return; } setDiscoveryAnswers(prev => ({ ...prev, ...Object.fromEntries(mandatory.map(item => [item.question, discoveryAnswers[item.question] || item.answer || ''])) })); } if (stage < 9) { setStage(stage + 1); setResult(null); } else setAccepted(true); };
  const regenerate = () => { const nextContext = { ...context, regeneration: Number(context.regeneration || 0) + 1 }; setContext(nextContext); runStage(stage, 'Regenerate this stage with genuinely new alternatives. Avoid every previously shown option and explain what changed.', nextContext); };
  const extractOptions = value => value?.names?.map(item => item.name).concat(value?.suggestions?.map(item => item.title) || [], value?.traits?.map(item => item.name) || [], value?.posterSuggestions?.map(item => item.label) || [], value?.tagline || []) || [];
  const saveEdit = () => { if (stage === 0) { setResult(prev => ({ ...prev, description: editText })); setContext(prev => ({ ...prev, description: editText })); setEditing(false); return; } try { const parsed = JSON.parse(editText); setResult(parsed); setContext(prev => ({ ...prev, ...parsed })); } catch { setError('Edit must be valid JSON.'); } setEditing(false); };
  const submitCustom = () => { if (!customDirection.trim()) return; runStage(stage, customDirection); setCustomDirection(''); };
  const sendChat = async () => { if (!chatInput.trim()) return; const message = chatInput; setChat(prev => [...prev, { role: 'user', text: message }]); setChatInput(''); const response = await fetch(`${API}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, context }) }); const text = await response.text(); let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { answer: 'The chat service is temporarily unavailable. Please try again.' }; } setChat(prev => [...prev, { role: 'assistant', text: body.answer || 'The chat service is temporarily unavailable. Please try again.' }]); };
  const exportPdf = async () => { const node = document.querySelector('.kit-page'); if (!node) return; const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#0A1128' }); const pdf = new jsPDF('p', 'mm', 'a4'); const ratio = Math.min(190 / canvas.width, 275 / canvas.height); pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 10, 10, canvas.width * ratio, canvas.height * ratio); const blob = pdf.output('blob'); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'sparkiq-brand-kit.pdf'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); };
  const approveFinal = async () => { setFinalLocked(true); await exportPdf(); };
  const buildWebsiteTemplate = () => {
    const name = context.name || context.names?.[0]?.name || 'SparkIQ';
    const tagline = context.tagline || 'Make the next move clearer.';
    const palette = (context.selectedPalette || context.palette || [{ hex: '#0A1128' }, { hex: '#3B82F6' }, { hex: '#B8C4D9' }, { hex: '#B8E05F' }]).slice(0, 4);
    const primary = palette[1]?.hex || '#3B82F6';
    const accent = palette[3]?.hex || '#B8E05F';
    const background = palette[0]?.hex || '#0A1128';
    const ink = palette[2]?.hex || '#B8C4D9';
    const about = context.oneLinePitch || 'A focused, considered brand built to turn a good idea into a memorable customer experience.';
    const launchText = context.landingHeadline || context.oneLinePitch || 'Launch without the noise.';
    const socials = context.instagram || '@sparkiqstudio';
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
    <style>
      :root {
        --bg: ${background};
        --primary: ${primary};
        --accent: ${accent};
        --ink: ${ink};
        --paper: #f5f8ff;
        --text: #10213d;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; font-family: Arial, sans-serif; background: var(--bg); color: var(--paper);
      }
      .container { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
      header { padding: 24px 0; border-bottom: 1px solid rgba(255,255,255,.14); }
      .nav { display: flex; justify-content: space-between; align-items: center; }
      .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; letter-spacing: .04em; }
      .mark { width: 30px; height: 30px; border-radius: 10px; background: linear-gradient(135deg, var(--ink), var(--primary), var(--accent)); }
      .cta { background: var(--primary); color: white; text-decoration: none; border-radius: 999px; padding: 12px 20px; display: inline-block; font-weight: 700; }
      .hero { padding: 72px 0 42px; }
      .hero-grid { display: grid; grid-template-columns: 1.4fr .9fr; gap: 28px; align-items: center; }
      h1 { font-size: clamp(2.8rem, 6vw, 5rem); line-height: 0.95; margin: 0 0 18px; }
      .lede { color: rgba(255,255,255,.8); font-size: 1.08rem; max-width: 600px; }
      .pill-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
      .pill { color: var(--paper); background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.10); padding: 9px 12px; border-radius: 999px; }
      .panel { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 24px; padding: 22px; }
      .card { background: var(--paper); color: var(--text); border-radius: 24px; padding: 24px; }
      .stats { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
      .stat { background: rgba(255,255,255,.06); border-radius: 18px; padding: 18px; }
      .stat strong { display: block; font-size: 1.5rem; margin-bottom: 5px; }
      section { padding: 28px 0; }
      .about { background: var(--paper); color: var(--text); border-radius: 28px; padding: 30px; }
      .cta-row { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 18px; }
      .socials { display: flex; gap: 10px; flex-wrap: wrap; }
      .socials a { background: rgba(16,33,61,.05); color: var(--text); text-decoration: none; padding: 8px 12px; border-radius: 999px; }
      @media (max-width: 760px) { .hero-grid { grid-template-columns: 1fr; } .nav { flex-wrap: wrap; gap: 12px; } }
    </style>
  </head>
  <body>
    <header>
      <div class="container nav">
        <div class="brand"><span class="mark"></span> ${name}</div>
        <a class="cta" href="#contact">Get early access</a>
      </div>
    </header>
    <main class="container">
      <section class="hero">
        <div class="hero-grid">
          <div>
            <p class="lede">Starter template • customize with your own copy</p>
            <h1>${name}</h1>
            <p class="lede">${tagline}</p>
            <div class="pill-row">
              <span class="pill">Brand starter</span>
              <span class="pill">Customizable layout</span>
              <span class="pill">Built for launch</span>
            </div>
          </div>
          <div class="panel">
            <div class="card">
              <h3>Launch snapshot</h3>
              <p>${launchText}</p>
              <div class="stats">
                <div class="stat"><strong>01</strong> Offer</div>
                <div class="stat"><strong>02</strong> Story</div>
                <div class="stat"><strong>03</strong> Proof</div>
                <div class="stat"><strong>04</strong> Reach</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="about">
        <h2>About</h2>
        <p>${about}</p>
        <div class="cta-row">
          <a class="cta" href="#contact">Contact</a>
          <a class="cta" href="#story" style="background: transparent; border: 1px solid rgba(16,33,61,.2); color: var(--text);">Learn more</a>
        </div>
      </section>

      <section id="story" class="panel">
        <h2>Launch content</h2>
        <p>${context.oneLinePitch || 'A simple promise, a clear audience, and a reason to believe.'}</p>
        <div class="socials" id="contact">
          <a href="${socials.startsWith('@') ? 'https://instagram.com/' + socials.replace('@', '') : socials}">${socials}</a>
          <a href="#">Contact</a>
          <a href="#">Book a call</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
  };
  const createWebsite = () => {
    const html = buildWebsiteTemplate();
    setWebsiteHtml(html);
  };
  const downloadPoster = async () => { const canvas = await html2canvas(document.querySelector('#poster'), { scale: 3 }); const link = document.createElement('a'); link.download = 'sparkiq-poster.png'; link.href = canvas.toDataURL(); link.click(); };
  const generateVideo = async () => { if (!result?.scenes?.length) return; setVideoGenerating(true); setError(''); try { const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; const drawing = canvas.getContext('2d'); const stream = canvas.captureStream(30); const audioContext = new AudioContext(); const destination = audioContext.createMediaStreamDestination(); stream.addTrack(destination.stream.getAudioTracks()[0]); const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus' }); const chunks = []; recorder.ondataavailable = event => event.data.size && chunks.push(event.data); const finished = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); }); const colors = (context.selectedPalette || context.palette || [{ hex: '#0A1128' }, { hex: '#2E5EAA' }, { hex: '#B8C4D9' }]).map(color => color.hex); const scenes = result.scenes; recorder.start(); for (let index = 0; index < scenes.length; index += 1) { const scene = scenes[index]; drawing.fillStyle = colors[index % colors.length] || '#0A1128'; drawing.fillRect(0, 0, canvas.width, canvas.height); drawing.fillStyle = '#ffffff'; drawing.font = '700 30px Space Grotesk, sans-serif'; drawing.fillText((context.name || 'SparkIQ').toUpperCase(), 72, 78); drawing.font = '500 58px Space Grotesk, sans-serif'; drawing.fillText(scene.onScreenText || 'Make the moment count', 72, 310); drawing.font = '400 25px DM Sans, sans-serif'; drawing.fillText(scene.visual || 'A considered brand moment', 72, 390); drawing.fillStyle = '#b8e05f'; drawing.fillRect(72, 585, 130, 8); const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain(); oscillator.frequency.value = 220 + index * 80; gain.gain.setValueAtTime(0.0001, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.05); gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 1.5); oscillator.connect(gain).connect(destination); oscillator.start(); oscillator.stop(audioContext.currentTime + 1.5); await new Promise(resolve => setTimeout(resolve, 1500)); } recorder.stop(); const blob = await finished; audioContext.close(); const url = URL.createObjectURL(blob); setVideoUrl(url); } catch (e) { setError(`Video generation failed: ${e.message || 'your browser may not support MediaRecorder'}`); } finally { setVideoGenerating(false); } };
  const currentName = context.names?.[0]?.name || context.name || 'Your brand';

  if (!idea && !result) return <main className="landing"><div className="noise" /><nav><div className="logo"><SparkLogo /><span className="wordmark">SparkIQ</span></div><div className="nav-note">Brand intelligence, made tangible</div></nav><section className="hero"><div className="eyebrow">A CONSIDERED START FOR WHAT IS NEXT</div><h1>Turn the rough idea<br /><i>into a brand people remember.</i></h1><p>One guided workspace for sharper positioning, a confident voice, and a launch-ready brand kit.</p><div className="idea-box"><textarea value={idea} onChange={e => setIdea(e.target.value)} placeholder="Tell us the rough idea in your own words..." /><button onClick={() => start()} disabled={!idea.trim()}>Build my brand <ArrowRight size={17} /></button></div><div className="theme-choice"><span>Set a mood early</span><button className={themePreference === 'premium' ? 'chosen' : ''} onClick={() => setThemePreference('premium')}>Premium / sleek</button><button className={themePreference === 'warm' ? 'chosen' : ''} onClick={() => setThemePreference('warm')}>Warm / handmade</button></div>{resumeAvailable && <button className="resume-button" onClick={resume}>Resume saved project</button>}</section><div className="hero-foot"><span>10 guided stages</span><span>AI checked outputs</span><span>Strategy, not noise</span></div></main>;

  return <main className="app-shell"><header><div className="logo"><SparkLogo /><span className="wordmark">SparkIQ</span></div><div className="header-idea">{idea}</div><button className="icon-button" onClick={() => setChatOpen(true)} title="Open founder doubt chat"><MessageCircle size={18} /></button></header><div className="progress"><div className="progress-line"><b style={{ width: `${(stage / 9) * 100}%` }} /></div>{stages.map((item, index) => <button className={index === stage ? 'active' : index < stage ? 'done' : ''} onClick={() => { setStage(index); setResult(null); }} key={item}><span>{index < stage ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span>{item}</button>)}</div><section className="workspace"><div className="stage-heading"><div><div className="eyebrow">STAGE {String(stage + 1).padStart(2, '0')} / 10</div><h2>{stages[stage]}</h2></div><div className="stage-actions"><button onClick={regenerate}><RefreshCw size={15} /> Regenerate</button><button onClick={() => { setEditing(true); setEditText(stage === 0 ? result?.description || '' : JSON.stringify(result, null, 2)); }}><Edit3 size={15} /> Edit</button></div></div>{loading ? <div className="loading"><div className="loader" /><h3>Building the next layer</h3><p>Reading your brand context and checking the result for clarity...</p></div> : <>{error && <div className="error inline-error"><X size={20} /><strong>{error}</strong><button onClick={() => setError('')}>Dismiss</button></div>}<StageView stage={stage} data={result} context={context} setContext={setContext} language={language} setLanguage={setLanguage} accepted={accepted} setAccepted={setAccepted} downloadPoster={downloadPoster} feedback={feedback} setFeedback={setFeedback} discoveryAnswers={discoveryAnswers} setDiscoveryAnswers={setDiscoveryAnswers} customDirection={customDirection} setCustomDirection={setCustomDirection} submitCustom={submitCustom} posterStyle={posterStyle} setPosterStyle={setPosterStyle} posterChoice={posterChoice} setPosterChoice={setPosterChoice} voiceStyle={voiceStyle} setVoiceStyle={setVoiceStyle} audioReady={audioReady} setAudioReady={setAudioReady} fullKit={fullKit} setFullKit={setFullKit} finalLocked={finalLocked} approveFinal={approveFinal} compareOpen={compareOpen} setCompareOpen={setCompareOpen} compareSelection={compareSelection} setCompareSelection={setCompareSelection} idea={idea} setIdea={setIdea} start={start} generateVideo={generateVideo} videoUrl={videoUrl} videoGenerating={videoGenerating} /></>}{!loading && result && <div className="bottom-bar"><div><Why text={result.reasoning || 'This decision uses the context gathered so far.'} /><span className="saved"><Check size={14} /> Context saved</span></div><button className="primary" onClick={next}>{stage === 9 ? 'View full kit' : 'Approve & continue'} <ArrowRight size={16} /></button></div>}</section>{editing && <div className="edit-modal"><div className="panel"><div className="panel-title">{stage === 0 ? 'Edit idea description' : `Edit ${stages[stage]} directly`}</div>{stage === 0 && <label className="edit-label">Describe the idea in plain language</label>}<textarea value={editText} onChange={event => setEditText(event.target.value)} placeholder={stage === 0 ? 'Write a short description of the idea...' : ''} /> <div className="modal-actions"><button className="outline" onClick={() => setEditing(false)}>Cancel</button><button className="primary" onClick={saveEdit}>Save edit</button></div></div></div>}{chatOpen && <aside className="chat-panel"><div className="chat-head"><div><strong>Founder doubt chat</strong><small>Grounded in your current brand</small></div><button onClick={() => setChatOpen(false)}><X size={18} /></button></div><div className="chat-messages">{chat.map((item, i) => <div className={item.role} key={i}>{item.text}</div>)}</div><div className="chat-input"><input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendChat()} placeholder="Ask a branding question..." /><button onClick={sendChat}><Send size={16} /></button></div></aside>}</main>;
}

function StageView({ stage, data, context, setContext, language, setLanguage, accepted, setAccepted, downloadPoster, feedback, setFeedback, discoveryAnswers, setDiscoveryAnswers, customDirection, setCustomDirection, submitCustom, posterStyle, setPosterStyle, posterChoice, setPosterChoice, voiceStyle, setVoiceStyle, audioReady, setAudioReady, fullKit, setFullKit, finalLocked, approveFinal, compareOpen, setCompareOpen, compareSelection, setCompareSelection, idea, setIdea, start, generateVideo, videoUrl, videoGenerating, roomType, setRoomType, roomSize, setRoomSize }) {
  if (!data && stage === 0) return <div className="discover-empty panel"><div className="panel-title">Start with your idea</div><p>Type a rough idea in your own words. SparkIQ will analyze it and then ask the right number of brief follow-up questions.</p><textarea value={idea} onChange={event => setIdea(event.target.value)} placeholder="Tell us the rough idea in your own words..." /><button className="primary" onClick={() => start()} disabled={!idea.trim()}>Submit idea <ArrowRight size={16} /></button></div>;
  if (!data) return <div className="loading"><div className="loader" /><h3>Waiting for this stage</h3><p>Submit the current stage before continuing.</p></div>;
  if (stage === 0) {
    const mandatoryQuestions = mandatoryDiscovery(data);
    const optionalQuestions = optionalDiscovery(data);
    const nextDisabled = !allRequiredDiscoveryAnswered(data);
    return <div className="content-grid"><div className="panel main-panel"><div className="panel-title">The foundation <span className="question-mode">{data.questionMode === 'deep discovery' ? 'Deep discovery' : 'Focused discovery'}</span></div><div className="big-answer">{data.idea}</div><Field label="Idea type"><div className="pill">{data.ideaType}</div></Field><Field label="Idea description"><p>{data.description}</p></Field><Field label="Brief discovery answers"><small className="required-note">{mandatoryQuestions.length} required answers must be completed before continuing</small>{mandatoryQuestions.map(item => <div className="brief-question required-question" key={item.question}><label>{item.question} <em>Required</em><small>{item.ideaContext}</small></label><input value={discoveryAnswers[item.question] || item.answer || ''} onChange={event => setDiscoveryAnswers(prev => ({ ...prev, [item.question]: event.target.value }))} placeholder="In a sentence or two..." /></div>)}{optionalQuestions.length > 0 && <div className="optional-questions"><div className="panel-title small-panel-title">Optional follow-ups <span className="question-mode optional-tag">Optional — skip if you're not sure</span></div>{optionalQuestions.map(item => <div className="brief-question optional-question" key={item.question}><label>{item.question}<small>{item.ideaContext}</small></label><input value={discoveryAnswers[item.question] || item.answer || ''} onChange={event => setDiscoveryAnswers(prev => ({ ...prev, [item.question]: event.target.value }))} placeholder="Optional follow-up" /></div>)}</div>}</Field><Field label="Made for"><p>{data.audience}</p></Field><Field label="Goals"><ul>{data.goals?.map(x => <li key={x}>{x}</li>)}</ul></Field></div><div className="panel side-panel"><div className="panel-title">Open questions <Why text="Questions that will sharpen the next decision." /></div>{data.openQuestions?.map((q, i) => <div className="question" key={q}><span>0{i + 1}</span>{q}</div>)}<div className="suggest-box"><Sparkles size={16} /><span>Not sure yet?</span><button onClick={() => submitCustom()}>Suggest for me</button></div></div></div>;
  }
  if (stage === 1) return <div className="suggestions">{data.suggestions?.map((item, i) => <div className={`suggestion ${accepted ? 'selected' : ''}`} key={item.title}><div className="suggestion-num">0{i + 1}</div><div><h3>{item.title} <Why text={item.whyChanged || item.reason} /></h3><p>{item.reason}</p><small>{item.impact} · {item.changed}</small></div><button onClick={() => { setAccepted(true); setContext(prev => ({ ...prev, sharpenChoice: item })); }}>{accepted ? <Check size={16} /> : 'Use this'}</button></div>)}<button className="compare-toggle" onClick={() => setCompareOpen(!compareOpen)}>Compare two options</button>{compareOpen && <div className="compare-grid">{data.suggestions?.slice(0, 2).map(item => <div className="panel" key={item.title}><strong>{item.title}</strong><p>{item.reason}</p><small>{item.impact}</small></div>)}</div>}<div className="custom-row"><Sparkles size={16} /><input value={customDirection} onChange={event => setCustomDirection(event.target.value)} onKeyDown={event => event.key === 'Enter' && submitCustom()} placeholder="Or tell SparkIQ your own direction..." /><button className="outline" onClick={submitCustom}>Use direction</button></div></div>;
  if (stage === 2) return <div className="position-grid"><div className="panel main-panel"><div className="panel-title">Recommended position <Why text={data.reasoning} /></div><h3 className="statement">{data.valueProposition}</h3><Field label="Category"><p>{data.category}</p></Field><Field label="Differentiator"><p>{data.differentiator}</p></Field><Field label="Competitive angle"><p>{data.competitiveAngle}</p></Field><div className="competitors"><strong>Competitor watchlist</strong>{data.competitors?.map(x => <span key={x.name}>{x.name} <small>{x.status}</small></span>)}</div></div><div className="debate panel"><div className="panel-title">Positioning debate <span className="live">LIVE</span></div>{data.debate?.map(x => <div className="debate-msg" key={x.agent}><b>{x.agent}</b><p>{x.message}</p></div>)}<button className="outline" onClick={() => setAccepted(true)}>{accepted ? 'Direction selected' : 'Choose this direction'}</button></div></div>;
  if (stage === 3) return <div className="trait-grid"><div><div className="traits">{data.traits?.map(t => <div className="trait" draggable key={t.name}><strong>{t.name}</strong><p>{t.reason}</p><label>Importance</label><input type="range" min="1" max="5" value={6 - (t.rank || 1)} onChange={event => setContext(prev => ({ ...prev, traitRanking: { ...(prev.traitRanking || {}), [t.name]: Number(event.target.value) } }))} /><Why text={t.reason} /></div>)}</div><div className="archetype panel"><strong>{data.archetype?.name}</strong><p>{data.archetype?.reason}</p></div><div className="values panel"><div className="panel-title">Brand values</div>{data.brandValues?.map(value => <div className="value-row" key={value.name}><strong>{value.name}</strong><p>{value.reason}</p></div>)}</div></div><div className="avoid panel"><div className="panel-title">Avoid <Why text="These traits would create distance from the intended audience." /></div>{data.avoidTraits?.map(t => <span key={t}><X size={13} /> {t}</span>)}</div></div>;
  if (stage === 4) return <div className="name-layout"><div className="name-list">{data.names?.map((n, i) => <button className={context.name === n.name ? 'chosen' : ''} key={n.name} onClick={() => setContext(prev => ({ ...prev, name: n.name }))}><span>0{i + 1}</span><div className="name-card"><strong>{n.name}</strong><small>{n.rationale}</small><div className="name-meta"><span>Technique: {n.technique || 'descriptive'}</span><span>{n.clicheCheck || 'Cliche risk: low'}</span></div></div><Why text={n.clicheCheck || 'Cliche risk is low for this naming direction.'} /></button>)}<button className="compare-toggle" onClick={() => setCompareOpen(!compareOpen)}>Compare two names</button>{compareOpen && <div className="compare-grid">{data.names?.slice(0, 2).map(item => <div className="panel" key={item.name}><strong>{item.name}</strong><p>{item.rationale}</p><small>Technique: {item.technique || 'descriptive'}</small></div>)}</div>}<div className="custom-row"><Sparkles size={16} /><input value={customDirection} onChange={event => setCustomDirection(event.target.value)} placeholder="Or tell SparkIQ your own name or direction..." /><button className="outline" onClick={submitCustom}>Refine</button></div></div><div className="panel tagline-card"><div className="panel-title">The verbal signature <Why text="Short enough to remember, specific enough to guide behavior." /></div><h3>{data.tagline}</h3><p>{data.oneLinePitch}</p><div className="cliche"><Check size={15} /> Cliche killer passed</div><small>Rejected: {data.rejectedCliches?.join(', ')}</small></div></div>;
  if (stage === 5) return <div className="visual-grid"><div className="panel visual-copy"><div className="panel-title">Visual direction <Why text={data.reasoning} /></div><div className="preference"><strong>How would you like your poster style?</strong><button className={posterStyle === 'minimal' ? 'chosen' : ''} onClick={() => setPosterStyle('minimal')}>Minimal & clean</button><button className={posterStyle === 'decorative' ? 'chosen' : ''} onClick={() => setPosterStyle('decorative')}>Decorative & rich</button><button className={posterStyle === 'bold' ? 'chosen' : ''} onClick={() => setPosterStyle('bold')}>Bold & modern</button></div><Field label="Color palette"><div className="palette-list">{(data.palettes || []).map(palette => <PaletteGroup palette={palette} selected={context.selectedPalette?.[0]?.hex === palette.colors?.[0]?.hex} onSelect={() => setContext(prev => ({ ...prev, selectedPalette: palette.colors, palette: palette.colors }))} key={palette.id} />)}</div></Field><Field label="Typography"><p>{data.typography?.display} <span>+</span> {data.typography?.body}</p></Field><Field label="Logo style"><p>{data.logoStyle}</p></Field><Field label="Shapes & image style"><p>{data.shapes} {data.imageStyle}</p></Field><Field label="Avoid"><p>{data.avoid?.join(' / ')}</p></Field><button className="outline" onClick={() => submitCustom()}>Regenerate posters with this palette</button></div><div className="poster-options">{(data.posterSuggestions || [{ id: 1, label: 'Suggestion 1', poster: data.poster }]).map(option => <div className={posterChoice === option.id ? 'poster-choice chosen' : 'poster-choice'} key={option.id}><span>{option.label}</span><Poster data={{ ...data, palette: context.selectedPalette || option.palette, poster: option.poster }} context={context} /><button className="outline full" onClick={() => setPosterChoice(option.id)}>{posterChoice === option.id ? <><Check size={15} /> Selected</> : 'Use this'}</button></div>)}<button className="compare-toggle" onClick={() => setCompareOpen(!compareOpen)}>Compare posters</button>{compareOpen && <div className="compare-grid">{data.posterSuggestions?.slice(0, 2).map(option => <div className="panel" key={option.id}><strong>{option.label}</strong><p>{option.layout} layout in the selected mood.</p></div>)}</div>}<button className="outline full" onClick={downloadPoster}><Download size={15} /> Download selected poster</button></div></div>;
  if (stage === 6) {
    const voiceSamples = [
      { name: 'Warm Female', description: 'Soft, welcoming, and quietly persuasive.', sample: 'A little spark can make the whole experience feel personal.' },
      { name: 'Confident Male', description: 'Clear, premium, and credible.', sample: 'This is a clear, credible point of view that earns trust quickly.' },
      { name: 'Energetic Youth', description: 'Fresh, upbeat, and magnetic.', sample: 'Fresh, bold, and built to stand out without the noise.' },
      { name: 'Calm Narrator', description: 'Thoughtful and steady.', sample: 'A thoughtful brand starts with clarity and a steady promise.' },
      { name: 'Friendly Casual', description: 'Warm and easygoing.', sample: 'Simple, warm, and easy to remember from the first moment.' },
      { name: 'Professional Formal', description: 'Polished and precise.', sample: 'This brand helps people make confident decisions with less friction.' },
      { name: 'Deep Authoritative', description: 'Strong and assured.', sample: 'Presence, clarity, and conviction are what make a brand stick.' },
      { name: 'Bright Cheerful', description: 'Playful and optimistic.', sample: 'Make the next step feel as good as the idea behind it.' }
    ];
    return <div className="voice-grid"><div className="panel main-panel"><div className="panel-title">Tone rules</div>{data.toneRules?.map((x, i) => <div className="rule" key={x}><b>0{i + 1}</b>{x}<Why text="This keeps the voice consistent across channels." /></div>)}{data.valueMessages?.length > 0 && <div className="value-messages"><strong>Values in practice</strong>{data.valueMessages.map(message => <p key={message}>{message}</p>)}</div>}</div><div className="examples-panel"><div className="example-col"><span>VOICE STYLE FOR AUDIO</span>{(data.voiceStyles || voiceSamples).map(style => <button className={voiceStyle === style.name ? 'voice-choice chosen' : 'voice-choice'} key={style.name} onClick={() => { setVoiceStyle(style.name); const preview = style.sample || style.description || style.name; window.speechSynthesis?.speak(new SpeechSynthesisUtterance(preview)); }}><Volume2 size={14} /> {style.name}<small>{style.description || style.sample}</small></button>)}<span>DO</span>{data.doExamples?.map(x => <p key={x}>“{x}”</p>)}{data.sampleMessages?.map(x => <p className="sample" key={x}>{x}</p>)}</div><div className="example-col dont"><span>DON'T</span>{data.dontExamples?.map(x => <p key={x}>“{x}”</p>)}</div></div></div>;
  }
  if (stage === 7) return <div className="script panel"><div className="script-head"><div className="panel-title">{data.duration} intro film</div><div className="video-actions"><button className="outline" onClick={() => { setAudioReady(true); window.speechSynthesis?.speak(new SpeechSynthesisUtterance(data.scenes?.map(s => s.voiceover).join(' '))); }}><Volume2 size={15} /> Preview voice</button><button className="primary" onClick={generateVideo} disabled={videoGenerating}>{videoGenerating ? 'Generating video...' : 'Generate Video'} </button></div></div>{audioReady && <div className="audio-ready"><Check size={15} /> Audio track ready: {data.audioTrack?.label || 'script-synced voice-over'} · {voiceStyle}</div>}{videoUrl && <div className="video-preview"><video controls src={videoUrl} /><a className="primary" href={videoUrl} download="sparkiq-brand-video.webm"><Download size={15} /> Download video</a></div>}{data.scenes?.map(s => <div className="scene" key={s.timestamp}><time>{s.timestamp}</time><div><strong>{s.visual}</strong><p>{s.voiceover}</p><small>{s.onScreenText}</small></div></div>)}<small className="muted">SparkIQ renders animated branded title cards with a synchronized audio track as a real WebM video file.</small></div>;
  if (stage === 8) {
    const ecommerce = data?.ecommerce || {};
    const isRoomDecor = /home decor|room decor|wall art|decor/.test((context.idea || '').toLowerCase()) || ecommerce.type === 'home decor / room decor';
    const roomOptions = ['Bedroom', 'Living Room', 'Studio / Small Room'];
    const sizeOptions = ['Small (<100 sq ft)', 'Medium (100-200 sq ft)', 'Large (200+ sq ft)'];
    const safeRoomType = roomType || 'Bedroom';
    const safeRoomSize = roomSize || 'Medium (100-200 sq ft)';
    const safeBrandName = context.name || context.names?.[0]?.name || 'Your brand';
    const roomSummary = `Recommended for a ${String(safeRoomType).toLowerCase()} at ${String(safeRoomSize).toLowerCase()}, keep styling compact and layered with sculptural wall art and a single statement accent.`;
    return <div className="launch-grid"><div className="panel launch-copy"><div className="panel-title">Launch recap before approval</div><h3>{data.landingHeadline}</h3><p>{data.oneLinePitch}</p><div className="recap"><span>Idea</span><b>{context.idea}</b><span>Name / tagline</span><b>{safeBrandName} / {context.tagline}</b><span>Personality</span><b>{context.traits?.map(item => item.name).join(', ')}</b><span>Visuals / voice</span><b>{context.palette?.map(item => item.hex).join(' · ')} / {context.toneRules?.[0]}</b></div><label>Instagram</label><blockquote>{data.instagram || '@sparkiqstudio'}</blockquote><label>LinkedIn</label><blockquote>{data.linkedin || 'sparkiq-brand'}</blockquote></div><div className="panel launch-copy"><div className="panel-title">Language adaptation</div><select value={language} onChange={e => setLanguage(e.target.value)}><option>English</option><option>Hindi</option><option>Tamil</option><option>French</option></select><p className="muted">Regenerate to culturally adapt the tagline and posts into {language}.</p>{data.ecommerce && <><div className="panel-title ecom-title">E-commerce guide</div>{isRoomDecor && <div className="room-selector"><strong>Room type</strong><div className="selection-row">{roomOptions.map(option => <button key={option} className={safeRoomType === option ? 'chosen' : ''} onClick={() => setRoomType(option)}>{option}</button>)}</div><strong>Room size</strong><div className="selection-row">{sizeOptions.map(option => <button key={option} className={safeRoomSize === option ? 'chosen' : ''} onClick={() => setRoomSize(option)}>{option}</button>)}</div><p>{roomSummary}</p></div>}<label>{data.ecommerce.channel}</label><h4>{data.ecommerce.listingTitle || (isRoomDecor ? `${context.name || 'Curated'} wall art for ${safeRoomType} • ${safeRoomSize}` : '')}</h4><p>{data.ecommerce.description || (isRoomDecor ? `Thoughtful wall art designed for ${String(safeRoomType).toLowerCase()} spaces, balancing visual texture and storage-friendly scale so the room feels elevated without clutter.` : '')}</p><div className="keyword-row">{(data.ecommerce.keywords || ['home decor', 'wall art', 'room styling']).map(x => <span key={x}>{x}</span>)}</div><ol>{(data.ecommerce.steps || ['Choose the room fit', 'Highlight the art story', 'Present a clean, shoppable collection']).map(x => <li key={x}>{x}</li>)}</ol></>}</div></div>;
  }
  return <FinalKit data={data} context={context} setContext={setContext} setFeedback={setFeedback} feedback={feedback} fullKit={fullKit} setFullKit={setFullKit} finalLocked={finalLocked} approveFinal={approveFinal} createWebsite={createWebsite} websiteHtml={websiteHtml} />;
}

function FinalKit({ data, context, setContext, setFeedback, feedback, fullKit, setFullKit, finalLocked, approveFinal, createWebsite, websiteHtml }) {
  const [editSection, setEditSection] = useState('');
  const [editValue, setEditValue] = useState('');

  const saveInline = () => {
    if (!editSection) return;
    setContext(prev => ({ ...prev, [editSection]: editValue }));
    setEditSection('');
  };

  const palette = context.selectedPalette || context.palette || [];

  return (
    <div className="kit-page">
      <div className="kit-hero">
        <div className="kit-brand-header">
          <SparkLogo className="logo-mark-large" />
          <div>
            <div className="eyebrow">BRAND KIT / 2026</div>
            <h1>{context.name || context.names?.[0]?.name || 'Your brand'}</h1>
            <p>{context.tagline || 'Make the next move clearer.'}</p>
          </div>
        </div>
        <div className="score-ring">
          <strong>{data.consistencyScore}</strong>
          <small>consistency</small>
        </div>
      </div>

      <div className="kit-grid">
        <section>
          <label>THE IDEA</label>
          <h3>{data.summary}</h3>
          <p>Audience: {context.audience}. Problem: {context.problem}. Goals: {context.goals?.join(', ')}.</p>

          <label>POSITIONING</label>
          <p>{context.valueProposition}</p>
          <p>Category: {context.category}. Differentiator: {context.differentiator}. Competitive angle: {context.competitiveAngle}.</p>

          <label>PERSONALITY</label>
          <div className="kit-tags">{context.traits?.sort((a, b) => (a.rank || 9) - (b.rank || 9)).map(x => <span key={x.name}>{x.name}</span>)}</div>
          <p>Avoid: {context.avoidTraits?.join(', ')}. {context.archetype?.name} fits because {context.archetype?.reason ? context.archetype.reason.toLowerCase() : 'it matches the intended audience and brand positioning.'}</p>

          <label>NAME + TAGLINE</label>
          <p>{context.name || context.names?.[0]?.name}: {context.tagline}. {context.oneLinePitch}</p>
        </section>

        <section>
          <label>VISUAL DIRECTION</label>
          <p>{context.logoStyle} {context.shapes} {context.imageStyle}</p>
          <div className="kit-swatches">{palette.map(color => <i key={color.hex} style={{ background: color.hex }} title={color.name} />)}</div>

          <label>VOICE + SAMPLES</label>
          <p>{context.toneRules?.join(' / ')}</p>
          <blockquote>{context.sampleMessages?.[0]}</blockquote>

          <label>VIDEO SCRIPT</label>
          <p>{context.duration} with {context.scenes?.length || 0} scenes. {context.audioTrack?.label || 'A polished brand intro sequence.'}</p>

          <label>LAUNCH CONTENT</label>
          <p>{context.landingHeadline || context.oneLinePitch}</p>
          <p>{context.instagram}</p>

          <label>QUALITY CHECK</label>
          {data.scores?.map(s => (
            <div className="score-line" key={s.area}>
              <span>{s.area}</span>
              <b>{s.uniqueness}/{s.consistency}</b>
              <small>{s.reason}</small>
            </div>
          ))}
        </section>
      </div>

      {fullKit && (
        <div className="full-kit-details">
          <label>FULL KIT REVIEW</label>
          <div className="consistency-preview">
            <div>
              <strong>{context.name || context.names?.[0]?.name}</strong>
              <small>{context.tagline}</small>
              <span>{palette.map(color => <i key={color.hex} style={{ background: color.hex }} />)}</span>
            </div>
            <Poster data={{ ...context, palette, poster: context.poster }} context={context} />
          </div>

          <p><b>Poster:</b> {context.posterStyle || 'minimal'} direction, selected poster suggestion, and chosen palette shown together above.</p>
          <p><b>Customer-ready voice:</b> {context.doExamples?.join(' ')} Avoid: {context.dontExamples?.join(' ')}</p>
          <p><b>E-commerce:</b> {context.ecommerce?.listingTitle || 'Advice is not required for this category.'}</p>

          <div className="inline-edit">
            <select value={editSection} onChange={event => {
              setEditSection(event.target.value);
              setEditValue(context[event.target.value] || '');
            }}>
              <option value="">Choose a section to edit</option>
              <option value="tagline">Tagline</option>
              <option value="valueProposition">Positioning</option>
              <option value="landingHeadline">Launch headline</option>
              <option value="summary">Kit summary</option>
            </select>
            {editSection && (
              <>
                <textarea value={editValue} onChange={event => setEditValue(event.target.value)} />
                <button className="outline" onClick={saveInline}>Save inline edit</button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="kit-footer">
        <FileText size={16} /> {finalLocked ? 'Kit locked as final' : 'Would you like to change anything before finalizing?'}
        <button onClick={() => setFullKit(true)}>View full kit</button>
        <button onClick={createWebsite}>Create a Website</button>
        <button onClick={async () => {
          const r = await fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context }) });
          const x = await r.json();
          await navigator.clipboard?.writeText(x.url);
          alert(`Share link copied: ${x.url}`);
        }}>Share kit</button>
        <button className="primary" disabled={finalLocked} onClick={approveFinal}>
          {finalLocked ? 'Final kit approved' : 'Approve & download PDF'}
          <Download size={15} />
        </button>
      </div>

      {websiteHtml && (
        <div className="website-preview">
          <div className="website-preview-header">
            <strong>Website starter preview</strong>
            <a href={`data:text/html;charset=utf-8,${encodeURIComponent(websiteHtml)}`} download="sparkiq-website-template.html">Download .html</a>
          </div>
          <iframe title="SparkIQ website preview" srcDoc={websiteHtml} />
        </div>
      )}

      <div className="feedback-demo">
        <strong>Customer feedback assistant</strong>
        <span>Demo feedback: “The idea feels personal, but I wanted faster ordering.”</span>
        <button onClick={() => setFeedback([...feedback, 'Reply drafted in your established brand voice: Thanks for helping us make the moment easier.'])}>
          {feedback.length ? 'Reply drafted' : 'Summarize feedback'}
        </button>
        {feedback.map(x => <p key={x}>{x}</p>)}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);