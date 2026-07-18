/* Home Game Hold'em — authoritative real-time server
 * Express serves the client; ws handles live game sync.
 * Server holds all cards; each client only ever receives its own hole cards
 * (others are redacted until showdown). One shared table.
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ===================== poker engine ===================== */
const RANKS = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};
function makeDeck(){
  const d=[]; for(let s=0;s<4;s++) for(let r=2;r<=14;r++) d.push({r,s});
  for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function eval5(cs){
  const rs=cs.map(c=>c.r).sort((a,b)=>b-a);
  const flush=cs.every(c=>c.s===cs[0].s);
  const uniq=[...new Set(rs)];
  let straight=0;
  if(uniq.length===5){
    if(uniq[0]-uniq[4]===4) straight=uniq[0];
    else if(uniq[0]===14&&uniq[1]===5&&uniq[4]===2) straight=5;
  }
  const cnt={}; rs.forEach(r=>cnt[r]=(cnt[r]||0)+1);
  const g=Object.entries(cnt).map(([r,c])=>[+r,c]).sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  if(flush&&straight) return [8,straight];
  if(g[0][1]===4) return [7,g[0][0],g[1][0]];
  if(g[0][1]===3&&g[1][1]===2) return [6,g[0][0],g[1][0]];
  if(flush) return [5,...rs];
  if(straight) return [4,straight];
  if(g[0][1]===3) return [3,g[0][0],g[1][0],g[2][0]];
  if(g[0][1]===2&&g[1][1]===2) return [2,g[0][0],g[1][0],g[2][0]];
  if(g[0][1]===2) return [1,g[0][0],g[1][0],g[2][0],g[3][0]];
  return [0,...rs];
}
function bestHand(cards){
  const n=cards.length;
  if(n===5) return eval5(cards);
  let best=null; const pick=[];
  (function go(start){
    if(pick.length===5){ const v=eval5(pick.map(i=>cards[i])); if(!best||cmp(v,best)>0) best=v; return; }
    for(let i=start;i<=n-(5-pick.length);i++){ pick.push(i); go(i+1); pick.pop(); }
  })(0);
  return best;
}
function cmp(a,b){ for(let i=0;i<Math.max(a.length,b.length);i++){ const x=a[i]||0,y=b[i]||0; if(x!==y) return x-y; } return 0; }
const HAND_NAMES=['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush'];
function handName(v){ if(v[0]===8&&v[1]===14) return 'Royal Flush'; return HAND_NAMES[v[0]]; }
const fmt = n => Number(n).toLocaleString('en-US');

/* ===================== table state ===================== */
const T = {
  host:null, buyIn:1000, sb:5, bb:10,
  phase:'lobby', players:[], dealer:undefined, handNum:0,
  deck:[], community:[], currentBet:0, minRaise:10, turn:-1, acted:[], result:null
};
const inHand = p => p.in && !p.folded;
const canAct = p => p.in && !p.folded && !p.allIn;

function newPlayer(id,name){
  return { id, name, stack:T.buyIn, buyIns:1, in:false, folded:false, allIn:false,
           bet:0, committed:0, cards:[], needsRebuy:false, connected:true };
}
function nextSeat(from, pred){
  const n=T.players.length;
  for(let i=1;i<=n;i++){ const idx=(from+i)%n; if(pred(T.players[idx])) return idx; }
  return -1;
}
function post(p, amt){ const a=Math.min(amt,p.stack); p.stack-=a; p.bet+=a; p.committed+=a; if(p.stack===0) p.allIn=true; return a; }

function startHand(){
  T.players.forEach(p=>{ p.in=p.stack>0; p.folded=false; p.allIn=false; p.bet=0; p.committed=0; p.cards=[]; });
  const live=T.players.filter(p=>p.in);
  if(live.length<2) return false;
  T.handNum++;
  T.dealer=nextSeat(T.dealer===undefined?-1:T.dealer, p=>p.in);
  T.deck=makeDeck(); T.community=[]; T.result=null;
  const headsUp=live.length===2;
  const sbIdx=headsUp?T.dealer:nextSeat(T.dealer,p=>p.in);
  const bbIdx=nextSeat(sbIdx,p=>p.in);
  post(T.players[sbIdx],T.sb); post(T.players[bbIdx],T.bb);
  T.players.forEach(p=>{ if(p.in) p.cards=[T.deck.pop(),T.deck.pop()]; });
  T.phase='preflop'; T.currentBet=T.bb; T.minRaise=T.bb; T.acted=[];
  T.turn=nextSeat(bbIdx,canAct);
  if(T.turn===-1) runOut();
  return true;
}
function applyAction(pid, action, amount){
  const idx=T.players.findIndex(p=>p.id===pid);
  if(idx!==T.turn) return;
  const p=T.players[idx];
  if(action==='fold'){ p.folded=true; }
  else if(action==='check'){ if(p.bet!==T.currentBet) return; T.acted.push(p.id); }
  else if(action==='call'){ post(p,T.currentBet-p.bet); T.acted.push(p.id); }
  else if(action==='raise'){
    const maxTo=p.bet+p.stack; let to=Math.min(amount,maxTo);
    if(to<=T.currentBet) return;
    const isFull=(to-T.currentBet)>=T.minRaise||to===maxTo;
    if(!isFull) return;
    if((to-T.currentBet)>=T.minRaise) T.minRaise=to-T.currentBet;
    post(p,to-p.bet); T.currentBet=Math.max(T.currentBet,p.bet); T.acted=[p.id];
  } else return;
  afterAction();
}
function afterAction(){
  const live=T.players.filter(inHand);
  if(live.length===1){
    const total=T.players.reduce((t,p)=>t+p.committed,0);
    live[0].stack+=total;
    T.result={ lines:[`${live[0].name} wins ${fmt(total)} — everyone folded`], reveals:[] };
    T.phase='result'; checkBusted(); return;
  }
  const actors=T.players.filter(canAct);
  const roundDone=actors.every(p=>T.acted.includes(p.id)&&p.bet===T.currentBet);
  if(roundDone||actors.length===0){ advancePhase(); }
  else {
    const nt=nextSeat(T.turn,p=>canAct(p)&&!(T.acted.includes(p.id)&&p.bet===T.currentBet));
    if(nt===-1) advancePhase(); else T.turn=nt;
  }
}
function advancePhase(){
  T.players.forEach(p=>p.bet=0);
  T.currentBet=0; T.minRaise=T.bb; T.acted=[];
  if(T.phase==='preflop'){ T.community.push(T.deck.pop(),T.deck.pop(),T.deck.pop()); T.phase='flop'; }
  else if(T.phase==='flop'){ T.community.push(T.deck.pop()); T.phase='turn'; }
  else if(T.phase==='turn'){ T.community.push(T.deck.pop()); T.phase='river'; }
  else { showdown(); return; }
  const actors=T.players.filter(canAct);
  if(actors.length<=1){ runOut(); return; }
  T.turn=nextSeat(T.dealer,canAct);
}
function runOut(){ while(T.community.length<5) T.community.push(T.deck.pop()); showdown(); }
function showdown(){
  const contrib=T.players.filter(p=>p.committed>0).map(p=>({p,c:p.committed}));
  const evals={}; T.players.filter(inHand).forEach(p=>{ evals[p.id]=bestHand([...p.cards,...T.community]); });
  const lines=[]; const winners=new Set();
  while(contrib.some(x=>x.c>0)){
    const lvl=Math.min(...contrib.filter(x=>x.c>0).map(x=>x.c));
    let pot=0; const elig=[];
    contrib.forEach(x=>{ if(x.c>0){ pot+=lvl; x.c-=lvl; if(inHand(x.p)) elig.push(x.p); } });
    let best=null,bestPs=[];
    elig.forEach(p=>{ const v=evals[p.id]; if(!best||cmp(v,best)>0){ best=v; bestPs=[p]; } else if(cmp(v,best)===0) bestPs.push(p); });
    const share=Math.floor(pot/bestPs.length); let rem=pot-share*bestPs.length;
    bestPs.forEach(p=>{ p.stack+=share; winners.add(p.id); });
    if(rem>0) bestPs[0].stack+=rem;
    const names=bestPs.map(p=>p.name).join(' & ');
    lines.push(`${names} win${bestPs.length>1?'':'s'} ${fmt(pot)} with ${handName(best)}`);
  }
  T.result={ lines:[...new Set(lines)],
    reveals:T.players.filter(inHand).map(p=>({name:p.name,cards:p.cards,hand:handName(evals[p.id]),won:winners.has(p.id)})) };
  T.phase='result'; checkBusted();
}
function checkBusted(){ T.players.forEach(p=>{ if(p.in&&p.stack===0) p.needsRebuy=true; }); }

/* ===================== per-client view ===================== */
function viewFor(pid){
  const showdown = T.phase==='result';
  return {
    host:T.host, buyIn:T.buyIn, sb:T.sb, bb:T.bb, phase:T.phase, handNum:T.handNum,
    dealer:T.dealer, turn:T.turn, currentBet:T.currentBet, minRaise:T.minRaise,
    community:T.community,
    pot:T.players.reduce((t,p)=>t+p.committed,0),
    result:T.result,
    you:pid,
    players:T.players.map(p=>({
      id:p.id, name:p.name, stack:p.stack, buyIns:p.buyIns, in:p.in,
      folded:p.folded, allIn:p.allIn, bet:p.bet, committed:p.committed,
      needsRebuy:p.needsRebuy, connected:p.connected,
      // only send real cards to their owner; others get facedown markers or showdown reveal
      cards: (p.id===pid || (showdown && inHand(p))) ? p.cards
             : (p.in && !p.folded && p.cards.length ? [{},{}] : [])
    }))
  };
}
function broadcast(){
  wss.clients.forEach(c=>{
    if(c.readyState===1 && c.pid){ try{ c.send(JSON.stringify({t:'state', s:viewFor(c.pid)})); }catch(e){} }
  });
}

/* ===================== message handling ===================== */
wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try{ m=JSON.parse(raw); }catch(e){ return; }
    const pid = ws.pid;

    if(m.t==='sit'){
      const name=String(m.name||'').trim().slice(0,14);
      if(!name) return;
      const id=name.toLowerCase();
      ws.pid=id;
      let p=T.players.find(x=>x.id===id);
      if(!p){
        if(T.players.length>=9){ ws.send(JSON.stringify({t:'err',msg:'Table is full (9 max).'})); return; }
        p=newPlayer(id,name); T.players.push(p);
        if(!T.host) T.host=id;
      } else { p.connected=true; }
      ws.send(JSON.stringify({t:'seated', you:id}));
      broadcast(); return;
    }
    if(!pid) return;

    if(m.t==='start'){ if(pid===T.host && startHand()) broadcast(); return; }
    if(m.t==='action'){ if(T.phase!=='lobby'&&T.phase!=='result'){ applyAction(pid,m.action,m.amount|0); broadcast(); } return; }
    if(m.t==='rebuy'){
      const p=T.players.find(x=>x.id===pid);
      if(p&&p.needsRebuy){ p.stack+=T.buyIn; p.buyIns++; p.needsRebuy=false; broadcast(); }
      return;
    }
    if(m.t==='settings'){
      if(pid!==T.host||T.phase!=='lobby') return;
      T.buyIn=Math.max(50,m.buyIn|0); T.sb=Math.max(1,m.sb|0); T.bb=Math.max(2,m.bb|0);
      T.players.forEach(p=>{ p.stack=T.buyIn; p.buyIns=1; });
      broadcast(); return;
    }
    if(m.t==='reset'){
      if(pid!==T.host) return;
      T.phase='lobby'; T.handNum=0; T.dealer=undefined; T.community=[]; T.deck=[]; T.result=null;
      T.players.forEach(p=>{ p.stack=T.buyIn; p.buyIns=1; p.in=false; p.folded=false; p.allIn=false;
        p.bet=0; p.committed=0; p.cards=[]; p.needsRebuy=false; });
      broadcast(); return;
    }
  });

  ws.on('close', ()=>{
    if(ws.pid){ const p=T.players.find(x=>x.id===ws.pid); if(p) p.connected=false; broadcast(); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log('Home Game Hold\'em listening on '+PORT));
