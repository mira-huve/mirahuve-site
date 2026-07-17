/* =========================================================
   MIRA HUVE — app.js
   설정(아래 두 줄)만 채우면 예약/어드민이 작동합니다.
   ========================================================= */
const SUPABASE_URL = 'https://ilcgpjxzlaoeuzmezvft.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsY2dwanh6bGFvZXV6bWV6dmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MDg3OTYsImV4cCI6MjA5MDM4NDc5Nn0.f35B2aiyHD00qJgfFCGaqLHWSe4jMY8Gw2QtiEVWHOc'; // Supabase → Settings → API → anon public
/* 어드민 인증은 Supabase Auth(이메일 로그인) + RLS로 처리합니다. 클라이언트 평문 비밀번호는 제거되었습니다. */

/* ---- 결제 (PortOne V2) ----
   KG이니시스 V2 테스트 채널 연동. 테스트 결제는 매일 23:00~23:50 자동취소됩니다.
   실연동 전환 시 PORTONE_CHANNEL_KEY 를 실연동 채널 키로 교체하세요. */
const PAYMENT_ENABLED = true;
const PORTONE_STORE_ID = 'store-bd5de6ee-17d5-4b4d-a7c5-18c8fc1d54db';
const PORTONE_CHANNEL_KEY = 'channel-key-dea2b7a1-2f26-43fa-89cb-c80042eeb450'; // KG이니시스 테스트
const SUBMIT_LABEL = PAYMENT_ENABLED ? '결제하고 예약 신청하기' : '예약 신청하기';

function genPaymentId(){ return 'mh_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

/* ---- 결제 리다이렉트 복귀 처리 ----
   모바일에서는 결제창이 페이지 전체를 PG로 이동시켰다가 redirectUrl로 돌아온다.
   돌아오면 JS 상태가 초기화되므로, 결제 직전 주문 내용을 sessionStorage에 보관해 두고
   복귀 시 paymentId/code 파라미터를 읽어 저장을 마저 완료한다. */
const PENDING_ORDER_KEY = 'mh_pending_order';
function stashPendingOrder(kind, row){ try{ sessionStorage.setItem(PENDING_ORDER_KEY, JSON.stringify({ kind, row })); }catch(e){} }
function readPendingOrder(){ try{ return JSON.parse(sessionStorage.getItem(PENDING_ORDER_KEY)||'null'); }catch(e){ return null; } }
function clearPendingOrder(){ try{ sessionStorage.removeItem(PENDING_ORDER_KEY); }catch(e){} }

async function handlePaymentRedirect(){
  const params = new URLSearchParams(location.search);
  const paymentId = params.get('paymentId');
  if(!paymentId && !params.get('transactionType')) return;   // 결제 복귀가 아님
  const code = params.get('code');                            // 있으면 실패/취소
  history.replaceState(null, '', location.pathname + location.hash); // 새로고침 시 중복 저장 방지
  const pending = readPendingOrder();
  if(!pending || !pending.row) return;
  const msg = $({ booking:'#formMsg', report:'#reportFormMsg', pair:'#pairFormMsg' }[pending.kind] || '#formMsg');
  if(code != null){
    clearPendingOrder();
    if(msg) fail(msg,'결제가 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요.');
    return;
  }
  const row = pending.row;
  row.payment_id = paymentId;
  row.pay_method = 'card';
  row.payment_status = 'paid'; // ⚠ 서버 검증 전 상태. 추후 Edge Function 검증 연동 필요.
  try{
    if(pending.kind==='booking'){ await db.createBooking(row); slotCache.delete(row.booking_date); }
    else if(pending.kind==='report'){ await db.createReportOrder(row); }
    else if(pending.kind==='pair'){ await db.createPairReportOrder(row); }
    clearPendingOrder();
    const okText = pending.kind==='booking'
      ? '결제가 완료되어 예약이 접수되었습니다. 확정 안내 메일을 곧 보내드릴게요. 감사합니다.'
      : pending.kind==='report'
        ? (row.has_report
          ? '리포트 신청이 접수되었습니다. 업로드해 주신 결과지를 바탕으로 다음날 리포트를 보내드릴게요. 감사합니다.'
          : '결제가 완료되어 리포트 신청이 접수되었습니다. 강점 진단 테스트 코드를 곧 보내드릴게요. 감사합니다.')
        : '결제가 완료되어 관계 리포트 신청이 접수되었습니다. 필요한 분께는 강점 진단 테스트 코드를 곧 보내드릴게요. 감사합니다.';
    if(msg){
      msg.className='form-msg ok';
      msg.textContent = okText;
      msg.scrollIntoView({ block:'center' });
    }
    showNotice(okText);
  }catch(err){
    console.error(err);
    if(msg){
      fail(msg,'결제는 완료되었지만 접수 저장 중 오류가 발생했습니다. 010-5205-5870 또는 mira@mirahuve.com으로 연락 주시면 바로 도와드리겠습니다.');
      msg.scrollIntoView({ block:'center' });
    }
  }
}

/* 결제창 호출 (성공 시 {paymentId} 반환, 실패/취소 시 throw) */
async function requestPortonePayment({ amount, orderName, customer }){
  if(!window.PortOne) throw new Error('PORTONE_SDK_MISSING');
  if(!PORTONE_CHANNEL_KEY || PORTONE_CHANNEL_KEY.includes('여기에')) throw new Error('CHANNEL_NOT_SET');
  const paymentId = genPaymentId();
  const res = await window.PortOne.requestPayment({
    storeId: PORTONE_STORE_ID,
    channelKey: PORTONE_CHANNEL_KEY,
    paymentId,
    orderName,
    totalAmount: amount,
    currency: 'CURRENCY_KRW',
    payMethod: 'CARD',
    customer: { fullName: customer.name, phoneNumber: customer.phone, email: customer.email },
    redirectUrl: location.origin + location.pathname
  });
  if(res && res.code != null) throw new Error(res.message || 'PAY_CANCELLED'); // 취소/실패
  return { paymentId: (res && res.paymentId) || paymentId };
}

/* ---- Supabase 연결 ---- */
const CONFIGURED = !SUPABASE_ANON_KEY.includes('붙여넣으세요');
let sbClient = null;
if (CONFIGURED && window.supabase) {
  sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/* ---- 서비스·슬롯 규칙 ---- */
const SERVICES = {
  individual: { key:'individual', label:'개인 상담', dur:60,  price:150000, weekendOnly:false,
    slots:['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00'] },
  youth:      { key:'youth',      label:'청소년·학부모 상담', dur:90, price:280000, weekendOnly:false,
    slots:['09:00','10:30','12:00','13:30','15:00','16:30','18:00','20:00'] },
  team:       { key:'team',       label:'팀 워크숍', dur:120, price:1000000, weekendOnly:false, noReportDiscount:true,
    slots:['09:00','11:00','13:00','15:00'] },
  couple:     { key:'couple',     label:'연인·부부 상담', dur:90, price:250000, weekendOnly:false,
    slots:['09:00','10:30','12:00','13:30','15:00','16:30','18:00','20:00'] }
};
const REPORT_DISCOUNT = 40; // 결과지 업로드 시 할인율(%)

/* ---- 강점 리포트 신청(추가 옵션 결제) ---- */
const REPORT_BASE_PRICE = 80000;       // 기본 리포트(강점총평+커리어+관계+팀·리더십+의사결정) 정상가 100,000원 → 할인
const REPORT_BASE_PRICE_ORIG = 100000;
const REPORT_BASE_PRICE_WITH_REPORT = 40000; // 기존 강점(34개) 결과지 업로드 시 기본 리포트 가격 — 추가 옵션 가격은 동일
/* 추가 옵션(페르소나) 가격 — 선택한 총 개수에 따라 개당 단가가 정해진다(전체 개수에 동일 단가 적용).
   1개 선택: 개당 10,000원 · 2개: 개당 7,000원 · 3개: 개당 6,000원 · 4개 이상: 개당 5,000원. */
const REPORT_OPTION_NOMINAL_PRICE = 10000;          // 정가 비교용(할인 전 기준가), 개당

function reportOptionUnitPrice(n){
  if(n <= 1) return 10000;
  if(n === 2) return 7000;
  if(n === 3) return 6000;
  return 5000;
}

function reportOptionsTotal(n){
  return n * reportOptionUnitPrice(n);
}
const PERSONAS = {
  parent:    { label:'부모로서의 나는?' },
  child:     { label:'자식으로서의 나는?' },
  lover:     { label:'애인으로서의 나는?' },
  founder:   { label:'스타트업대표로서의 나는?' },
  teamlead:  { label:'조직의 팀장으로서 나는?' },
  colleague: { label:'조직의 동료로서의 나는?' },
  aibuilder: { label:'AI Builder로서의 나는?' },
  custom:    { label:'기타 (직접 입력)' }
};
const REPORT_SUBMIT_LABEL = PAYMENT_ENABLED ? '결제하고 리포트 신청하기' : '리포트 신청하기';

/* ---- 관계 리포트(두 사람) 신청 ---- */
const PAIR_REPORT_PRICE_ORIG = 200000;
/* 강점 진단 결과지를 이미 가진 인원 수에 따른 할인 — 0명 150,000원 · 1명 130,000원 · 2명 100,000원 */
const PAIR_REPORT_PRICE_BY_REPORT_COUNT = [150000, 130000, 100000];
function pairReportPrice(p1HasReport, p2HasReport){
  const n = (p1HasReport?1:0) + (p2HasReport?1:0);
  return PAIR_REPORT_PRICE_BY_REPORT_COUNT[n];
}
/* 관계 유형 — roles가 있으면 비대칭 관계(두 사람에게 서로 다른 역할을 배정해야 함), null이면 대칭 관계 */
const RELATIONSHIPS = {
  lover:   { label:'애인',      roles:null },
  couple:  { label:'부부',      roles:null },
  friend:  { label:'친구',      roles:null },
  family:  { label:'부모자식',   roles:['부모','자식'] },
  sibling: { label:'형제자매',   roles:['형·언니·오빠','동생'] },
  org_peer:{ label:'동료 · 동료', roles:null },
  org_lead:{ label:'팀장 · 팀원', roles:['팀장','팀원'] },
  org_ceo: { label:'대표 · 직원', roles:['대표','직원'] }
};
/* 대칭 관계(roles:null)의 사람1/사람2 헤더 라벨 — "나"를 신청자 기준으로 표시 */
const SYMMETRIC_PERSON_LABELS = {
  lover:    ['나','나의 연인'],
  couple:   ['나','나의 배우자'],
  friend:   ['나','나의 친구'],
  org_peer: ['나','나의 동료']
};
const PAIR_SUBMIT_LABEL = PAYMENT_ENABLED ? '결제하고 신청하기' : '신청하기';
/* 예약 가능기간 — 오늘부터 MIN_LEAD_DAYS 뒤 ~ WINDOW_DAYS 이내에서만 예약 가능 */
const BOOKING_MIN_LEAD_DAYS = 2;   // 상담 24h 전 테스트 완료 필요 → 최소 2일 뒤부터
const BOOKING_WINDOW_DAYS   = 90;  // 이니시스 계약조건 기준 90일 이내
const DOW = ['일','월','화','수','목','금','토'];
const STATUS_LABEL = { pending:'대기', confirmed:'확정', completed:'완료', cancelled:'취소' };

/* ---- 유틸 ---- */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const toMin = t => { const [h,m]=t.split(':').map(Number); return h*60+m; };
const parseDate = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); };
const isWeekend = s => { const d=parseDate(s).getDay(); return d===0||d===6; };
const overlap = (s1,e1,s2,e2) => s1 < e2 && s2 < e1;
const todayStr = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const won = n => (Number(n)||0).toLocaleString('ko-KR') + '원';
const dateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const timeStr = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
/* 오늘 기준 N일 뒤 날짜 문자열(YYYY-MM-DD) */
const offsetDateStr = days => { const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+days); return dateStr(d); };
const minBookDate = () => offsetDateStr(BOOKING_MIN_LEAD_DAYS);
const maxBookDate = () => offsetDateStr(BOOKING_WINDOW_DAYS);

/* 취소 마감(상담-24h) & 자동취소 */
const CANCEL_LEAD_MS = 24*3600*1000;
function bookingDateTime(b){
  const [y,m,d]=b.booking_date.split('-').map(Number);
  const [hh,mm]=(b.booking_time||'00:00').split(':').map(Number);
  return new Date(y,m-1,d,hh,mm);
}
const deadlineMs = b => bookingDateTime(b).getTime() - CANCEL_LEAD_MS;
function fmtDateTime(ms){ const d=new Date(ms); return `${dateStr(d)} (${DOW[d.getDay()]}) ${timeStr(d)}`; }
function relText(ms){ const diff=ms-Date.now(); if(diff<=0) return '(지남)'; const h=diff/3600000; return h<48?`(약 ${Math.round(h)}시간 남음)`:`(${Math.ceil(h/24)}일 남음)`; }

/* 결과지(업로드) 적용 시 가격 계산 — 팀 워크숍은 할인 대상 아님 */
function priceFor(serviceKey, hasReport){
  const svc = SERVICES[serviceKey] || {};
  const base = svc.price || 0;
  const rate = (hasReport && !svc.noReportDiscount) ? REPORT_DISCOUNT : 0;
  const final = Math.round(base * (100 - rate) / 100);
  return { base, rate, final };
}

/* =========================================================
   데이터 계층 (나중에 백엔드 교체 시 이 부분만 수정)
   ========================================================= */
const db = {
  async uploadReport(file){
    if(!CONFIGURED) throw new Error('NOT_CONFIGURED');
    const ext = (file.name.split('.').pop()||'dat').replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
    const safe = `report.${ext}`;
    const path = `${Date.now()}_${safe}`;
    const { error } = await sbClient.storage.from('reports').upload(path, file, { upsert:false });
    if(error) throw error;
    return path;
  },
  async reportSignedUrl(path){
    const { data, error } = await sbClient.storage.from('reports').createSignedUrl(path, 3600);
    if(error) throw error;
    return data.signedUrl;
  },
  async createBooking(row){
    if(!CONFIGURED) throw new Error('NOT_CONFIGURED');
    // .select() 없이 INSERT만 — 익명(anon)은 bookings 읽기 권한이 없으므로 반환 표현을 요구하지 않는다
    const { error } = await sbClient.from('bookings').insert([row]);
    if(error) throw error;
    return true;
  },
  async listBookings(){
    if(!CONFIGURED) return [];
    const { data, error } = await sbClient.from('bookings').select('*').order('created_at',{ascending:false});
    if(error) throw error;
    return data||[];
  },
  async bookingsOnDate(date){
    if(!CONFIGURED) return [];
    // 개인정보 없이 '해당 날짜의 예약된 시간대'만 반환하는 함수(RPC). anon도 실행 가능하나 고객 정보는 노출되지 않는다.
    const { data } = await sbClient.rpc('slots_on_date', { d: date });
    return data||[];
  },
  async customerHistory(email){
    if(!CONFIGURED) return [];
    const { data } = await sbClient.from('bookings').select('*')
      .eq('customer_email',email).order('booking_date',{ascending:false});
    return data||[];
  },
  async updateBooking(id, patch){
    patch.updated_at = new Date().toISOString();
    const { error } = await sbClient.from('bookings').update(patch).eq('id',id);
    if(error) throw error;
  },
  async listBlocks(){
    if(!CONFIGURED) return [];
    const { data } = await sbClient.from('blocked_slots').select('*').order('block_date',{ascending:true});
    return data||[];
  },
  async blocksOnDate(date){
    if(!CONFIGURED) return [];
    const { data } = await sbClient.from('blocked_slots').select('block_time').eq('block_date',date);
    return data||[];
  },
  async addBlock(row){
    const { error } = await sbClient.from('blocked_slots').insert([row]);
    if(error) throw error;
  },
  async removeBlock(id){
    const { error } = await sbClient.from('blocked_slots').delete().eq('id',id);
    if(error) throw error;
  },
  async createReportOrder(row){
    if(!CONFIGURED) throw new Error('NOT_CONFIGURED');
    const { error } = await sbClient.from('report_orders').insert([row]);
    if(error) throw error;
    return true;
  },
  async listReportOrders(){
    if(!CONFIGURED) return [];
    const { data, error } = await sbClient.from('report_orders').select('*').order('created_at',{ascending:false});
    if(error) throw error;
    return data||[];
  },
  async updateReportOrder(id, patch){
    patch.updated_at = new Date().toISOString();
    const { error } = await sbClient.from('report_orders').update(patch).eq('id',id);
    if(error) throw error;
  },
  async createPairReportOrder(row){
    if(!CONFIGURED) throw new Error('NOT_CONFIGURED');
    const { error } = await sbClient.from('pair_report_orders').insert([row]);
    if(error) throw error;
    return true;
  },
  async listPairReportOrders(){
    if(!CONFIGURED) return [];
    const { data, error } = await sbClient.from('pair_report_orders').select('*').order('created_at',{ascending:false});
    if(error) throw error;
    return data||[];
  },
  async updatePairReportOrder(id, patch){
    patch.updated_at = new Date().toISOString();
    const { error } = await sbClient.from('pair_report_orders').update(patch).eq('id',id);
    if(error) throw error;
  }
};

/* =========================================================
   네비게이션 / 스크롤 리빌
   ========================================================= */
/* 강점 4대 영역 카드 — 호버 시 뒤집혀 개별 강점 테마를 보여줌. 터치·키보드 사용자를 위해 탭/Enter로도 토글 */
function initDomainFlip(){
  $$('.domain-card').forEach(card=>{
    card.setAttribute('tabindex','0');
    card.addEventListener('click', ()=> card.classList.toggle('flipped'));
    card.addEventListener('keydown', e=>{
      if(e.key==='Enter' || e.key===' '){ e.preventDefault(); card.classList.toggle('flipped'); }
    });
  });
}

function initNav(){
  const toggle = $('#navToggle'), links = $('#navLinks');
  toggle?.addEventListener('click', ()=> links.classList.toggle('open'));
  $$('#navLinks a').forEach(a=> a.addEventListener('click', ()=> links.classList.remove('open')));

  const io = new IntersectionObserver(entries=>{
    entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('visible'); io.unobserve(e.target); } });
  }, { threshold:0.12 });
  $$('.reveal').forEach(el=> io.observe(el));
}

/* =========================================================
   예약 폼
   ========================================================= */
const state = { service:null, date:null, time:null };

function initBooking(){
  const dateInput = $('#bDate');
  dateInput.min = minBookDate();
  dateInput.max = maxBookDate();

  // 폼 안 서비스 선택
  $$('#servicePick .pick').forEach(btn=>{
    btn.addEventListener('click', ()=> selectService(btn.dataset.service));
  });

  // 홈페이지 서비스 카드에서 ?service=키 로 넘어온 경우 해당 서비스를 미리 선택해 둔다
  const preselect = new URLSearchParams(location.search).get('service');
  if(preselect && SERVICES[preselect]) selectService(preselect);

  dateInput.addEventListener('change', ()=>{ state.date = dateInput.value; state.time=null; renderSlots(); });

  // 결과지 보유 체크 → 업로드 필드 표시
  $('#bReport').addEventListener('change', e=>{
    $('#reportUploadWrap').hidden = !e.target.checked;
    if(!e.target.checked) $('#bReportFile').value = '';
    updatePricePreview();
  });
  $('#bReportFile').addEventListener('change', updatePricePreview);

  $('#bookingForm').addEventListener('submit', submitBooking);

  // 결제 활성화 시 버튼 문구 변경 (이니시스 결제창 안에서 카드 선택)
  if(PAYMENT_ENABLED){
    const sb=$('#submitBtn'); if(sb) sb.textContent=SUBMIT_LABEL;
  }
}

/* 선택된 서비스·결과지 여부에 따른 금액 미리보기 */
function updatePricePreview(){
  const box = $('#pricePreview');
  if(!state.service){ box.hidden = true; box.innerHTML = ''; return; }
  const svc = SERVICES[state.service];
  const checked = $('#bReport').checked;
  const hasFile = checked && $('#bReportFile').files.length > 0;
  const { base, rate, final } = priceFor(state.service, hasFile);
  box.hidden = false;

  if(svc.noReportDiscount){
    box.innerHTML = `상담비 <strong>${won(base)}</strong>`
      + (checked ? `<span class="save-hint">팀 워크숍은 결과지 할인 대상이 아닙니다.</span>` : '');
  } else if(rate > 0){
    box.innerHTML = `<s>${won(base)}</s> <strong>${won(final)}</strong> <em>(40% 할인 적용)</em>`;
  } else if(checked){
    box.innerHTML = `상담비 <strong>${won(base)}</strong>`
      + `<span class="save-hint">결과지를 업로드하면 ${won(priceFor(state.service,true).final)} (40% 할인)</span>`;
  } else {
    box.innerHTML = `상담비 <strong>${won(base)}</strong>`;
  }
}

function selectService(key){
  state.service = key; state.time = null;
  $$('#servicePick .pick').forEach(p=> p.classList.toggle('active', p.dataset.service===key));
  const svc = SERVICES[key];
  $('#dateHint').textContent = svc.weekendOnly
    ? `주말(토·일) · 예약일로부터 ${BOOKING_WINDOW_DAYS}일 이내에서 선택해 주세요.`
    : `오늘로부터 ${BOOKING_MIN_LEAD_DAYS}일 뒤 ~ ${BOOKING_WINDOW_DAYS}일 이내에서 선택해 주세요.`;
  if(state.date) renderSlots();
  updatePricePreview();
}

/* 날짜별 예약·차단 현황 캐시 (짧은 TTL — 재선택 시 즉시 표시) */
const slotCache = new Map();       // date -> { at, bookings, blocks }
const SLOT_CACHE_TTL = 30000;      // 30초
async function fetchAvailability(date){
  const hit = slotCache.get(date);
  if(hit && (Date.now() - hit.at) < SLOT_CACHE_TTL) return hit;
  // 예약 조회·차단 조회를 병렬로 실행 (순차 왕복 → 1회 왕복)
  const [bookings, blocks] = await Promise.all([
    db.bookingsOnDate(date).catch(()=>[]),
    db.blocksOnDate(date).catch(()=>[])
  ]);
  const entry = { at: Date.now(), bookings, blocks };
  slotCache.set(date, entry);
  return entry;
}

/* 슬롯 버튼 그리기. loading=true면 아직 가용성 미확정(전부 클릭 가능하게 낙관적 표시) */
function paintSlots(grid, svc, data, loading){
  const bookings = data.bookings || [], blocks = data.blocks || [];
  const fullDay = blocks.some(b=> !b.block_time);
  grid.innerHTML = '';
  svc.slots.forEach(slot=>{
    const s = toMin(slot), e = s + svc.dur;
    let taken = fullDay;
    if(!taken) taken = bookings.some(bk=> overlap(s, e, toMin(bk.booking_time), toMin(bk.booking_time)+(bk.duration_min||60)));
    if(!taken) taken = blocks.some(b=> b.block_time && toMin(b.block_time) >= s && toMin(b.block_time) < e);

    const btn = document.createElement('button');
    btn.type='button';
    btn.className = 'slot' + (taken?' taken':'') + (state.time===slot?' active':'');
    btn.textContent = slot;
    if(taken){
      btn.disabled = true;
      if(state.time===slot) state.time = null;   // 조회 결과 예약 마감된 슬롯을 골랐다면 해제
    } else {
      btn.addEventListener('click', ()=>{
        state.time = slot;
        $$('.slot',grid).forEach(x=> x.classList.remove('active'));
        btn.classList.add('active');
      });
    }
    grid.appendChild(btn);
  });
  if(loading){
    const tag = document.createElement('span');
    tag.className = 'slot-empty loading';
    tag.textContent = '예약 가능 여부 확인 중…';
    grid.appendChild(tag);
  }
}

async function renderSlots(){
  const grid = $('#slotGrid');
  const svc = state.service && SERVICES[state.service];
  if(!svc){ grid.innerHTML = '<span class="slot-empty">서비스를 먼저 선택해 주세요.</span>'; return; }
  if(!state.date){ grid.innerHTML = '<span class="slot-empty">날짜를 선택하면 가능한 시간이 표시됩니다.</span>'; return; }
  if(state.date < minBookDate() || state.date > maxBookDate()){
    state.time = null;
    grid.innerHTML = `<span class="slot-empty">예약은 오늘로부터 ${BOOKING_MIN_LEAD_DAYS}일 뒤 ~ ${BOOKING_WINDOW_DAYS}일 이내에서만 가능합니다.</span>`; return;
  }
  if(svc.weekendOnly && !isWeekend(state.date)){
    grid.innerHTML = '<span class="slot-empty">이 서비스는 주말(토·일)만 예약 가능합니다.</span>'; return;
  }

  const reqDate = state.date, reqSvc = svc.key;
  const cached = slotCache.get(reqDate);
  const fresh = cached && (Date.now() - cached.at) < SLOT_CACHE_TTL;

  // 1) 캐시가 있으면 그대로, 없으면 즉시 낙관적 렌더 → 화면이 바로 뜬다
  paintSlots(grid, svc, fresh ? cached : { bookings:[], blocks:[] }, !fresh);
  if(fresh) return;

  // 2) 가용성 데이터 도착 후 예약/차단된 시간만 비활성화
  let data;
  try { data = await fetchAvailability(reqDate); }
  catch(e){ data = { bookings:[], blocks:[] }; }
  if(state.date !== reqDate || state.service !== reqSvc) return;  // 그 사이 선택이 바뀌면 무시
  paintSlots(grid, svc, data, false);
}

async function submitBooking(ev){
  ev.preventDefault();
  const msg = $('#formMsg'); msg.className='form-msg'; msg.textContent='';
  if(!state.service){ return fail(msg,'서비스를 선택해 주세요.'); }
  if(!state.date){ return fail(msg,'날짜를 선택해 주세요.'); }
  if(state.date < minBookDate() || state.date > maxBookDate()){
    return fail(msg,`예약은 오늘로부터 ${BOOKING_MIN_LEAD_DAYS}일 뒤 ~ ${BOOKING_WINDOW_DAYS}일 이내에서만 가능합니다.`);
  }
  if(!state.time){ return fail(msg,'시간을 선택해 주세요.'); }

  const svc = SERVICES[state.service];
  const wantReport = $('#bReport').checked;
  const file = $('#bReportFile').files[0] || null;
  if(wantReport && !file){
    return fail(msg,'할인 적용을 위해 강점 진단 결과지 파일을 업로드해 주세요.');
  }

  const hasReport = !!(wantReport && file && !svc.noReportDiscount);
  const { base, rate, final } = priceFor(state.service, hasReport);

  const row = {
    service_key: svc.key,
    service_label: svc.label,
    duration_min: svc.dur,
    booking_date: state.date,
    booking_time: state.time,
    customer_name: $('#bName').value.trim(),
    customer_phone: $('#bPhone').value.trim(),
    customer_email: $('#bEmail').value.trim(),
    purpose: $('#bPurpose').value,
    purpose_detail: $('#bDetail').value.trim(),
    has_report: hasReport,
    base_price: base,
    final_price: final,
    discount_rate: rate,
    status: 'pending'
  };
  if(!row.customer_name || !row.customer_phone || !row.customer_email){
    return fail(msg,'이름·연락처·이메일을 모두 입력해 주세요.');
  }

  const btn = $('#submitBtn'); btn.disabled=true; btn.textContent='접수 중…';
  try{
    // 1) 결과지 업로드 — 결제 전에 먼저. 모바일 결제는 페이지가 PG로 이동했다가 돌아오므로
    //    File 객체가 유지되지 않는다. 업로드 경로만 row에 담아 sessionStorage로 보관한다.
    if(wantReport && file){
      btn.textContent='결과지 업로드 중…';
      row.report_path = await db.uploadReport(file);
    }
    // 2) 결제 (활성화된 경우에만)
    if(PAYMENT_ENABLED){
      btn.textContent='결제 진행 중…';
      stashPendingOrder('booking', row);   // 모바일 리다이렉트 복귀용
      try{
        const pay = await requestPortonePayment({
          amount: final, orderName: svc.label,
          customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email }
        });
        row.payment_id = pay.paymentId;
        row.pay_method = 'card';
        row.payment_status = 'paid'; // ⚠ 서버 검증 전 상태. 추후 Edge Function 검증 연동 필요.
      }catch(pe){
        clearPendingOrder();
        btn.disabled=false; btn.textContent=SUBMIT_LABEL;
        if(pe.message==='CHANNEL_NOT_SET' || pe.message==='PORTONE_SDK_MISSING'){
          return fail(msg,'결제 설정이 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        }
        return fail(msg,'결제가 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요.');
      }
    }
    // 3) 예약 저장
    await db.createBooking(row);
    clearPendingOrder();
    slotCache.delete(row.booking_date);   // 방금 예약한 날짜 캐시 무효화 → 즉시 마감 반영
    msg.className='form-msg ok';
    msg.textContent = PAYMENT_ENABLED
      ? `결제가 완료되어 예약이 접수되었습니다. 확정 안내 메일을 곧 보내드릴게요. 감사합니다.`
      : (rate > 0
        ? `예약이 접수되었습니다. 결과지 확인 후 40% 할인된 ${won(final)}으로 안내드릴게요. 감사합니다.`
        : '예약이 접수되었습니다. 확정 안내 메일을 곧 보내드릴게요. 감사합니다.');
    showNotice(msg.textContent);
    $('#bookingForm').reset();
    $('#reportUploadWrap').hidden = true;
    $('#pricePreview').hidden = true;
    state.service=state.date=state.time=null;
    $$('#servicePick .pick').forEach(p=>p.classList.remove('active'));
    $('#slotGrid').innerHTML='<span class="slot-empty">날짜를 선택하면 가능한 시간이 표시됩니다.</span>';
  }catch(err){
    if(err.message==='NOT_CONFIGURED'){
      fail(msg,'예약 시스템이 아직 연결되지 않았습니다. (Supabase 키 입력 필요)');
    } else if(wantReport && file && !row.report_path){
      fail(msg,'결과지 업로드에 실패했습니다. (Storage \'reports\' 버킷 설정을 확인해 주세요)');
      console.error(err);
    } else {
      fail(msg,'접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      console.error(err);
    }
  }finally{ btn.disabled=false; btn.textContent=SUBMIT_LABEL; }
}
function fail(el,t){ el.className='form-msg err'; el.textContent=t; }

/* 접수 완료 안내 팝업 — [확인]을 누르면 닫힌다. 세 신청 폼이 공유한다. */
function showNotice(text){
  let m = $('#noticeModal');
  if(!m){
    m = document.createElement('div');
    m.className = 'modal';
    m.id = 'noticeModal';
    m.innerHTML = `<div class="modal-box notice-box"><p id="noticeText"></p><button type="button" class="btn-primary" id="noticeOk">확인</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#noticeOk').addEventListener('click', ()=>{ m.hidden = true; });
    m.addEventListener('click', e=>{ if(e.target === m) m.hidden = true; });
  }
  m.querySelector('#noticeText').textContent = text;
  m.hidden = false;
  m.querySelector('#noticeOk').focus();
}

/* =========================================================
   강점 리포트 신청 폼
   ========================================================= */
const reportState = { personas: new Set(), customList: [] };

function initReportOrder(){
  $$('#personaPick .persona').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.dataset.persona;
      if(key === 'custom'){
        const wrap = $('#customPersonaWrap');
        wrap.hidden = !wrap.hidden;
        btn.classList.toggle('active', !wrap.hidden);
        if(!wrap.hidden){ $('#rCustomPersona').focus(); }
        else {
          // 닫으면 선택 해제로 간주 — 추가해 둔 직접입력 옵션도 비워 가격에서 제외한다
          reportState.customList = [];
          $('#rCustomPersona').value = '';
          renderCustomPersonaList();
          updateReportPricePreview();
        }
        return;
      }
      if(reportState.personas.has(key)){ reportState.personas.delete(key); btn.classList.remove('active'); }
      else { reportState.personas.add(key); btn.classList.add('active'); }
      updateReportPricePreview();
    });
  });

  $('#rCustomPersonaAdd').addEventListener('click', addCustomPersona);
  $('#rCustomPersona').addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); addCustomPersona(); }
  });

  $('#rHasReport').addEventListener('change', e=>{
    $('#rReportUploadWrap').hidden = !e.target.checked;
    if(!e.target.checked) $('#rReportFile').value = '';
    updateReportPricePreview();
  });

  updateReportPricePreview();
  $('#reportOrderForm').addEventListener('submit', submitReportOrder);
  const sb = $('#reportSubmitBtn'); if(sb) sb.textContent = REPORT_SUBMIT_LABEL;
}

function addCustomPersona(){
  const input = $('#rCustomPersona');
  const text = input.value.trim();
  if(!text) return;
  reportState.customList.push(text);
  input.value = '';
  input.focus();
  renderCustomPersonaList();
  updateReportPricePreview();
}

function renderCustomPersonaList(){
  const box = $('#customPersonaList');
  box.innerHTML = '';
  reportState.customList.forEach((text, idx)=>{
    const chip = document.createElement('span');
    chip.className = 'custom-chip';
    chip.innerHTML = `${esc(text)} <button type="button" aria-label="삭제">×</button>`;
    chip.querySelector('button').addEventListener('click', ()=>{
      reportState.customList.splice(idx, 1);
      renderCustomPersonaList();
      updateReportPricePreview();
    });
    box.appendChild(chip);
  });
}

function reportPersonaCount(){ return reportState.personas.size + reportState.customList.length; }

function updateReportPricePreview(){
  const box = $('#reportPricePreview');
  const n = reportPersonaCount();
  const hasReport = $('#rHasReport').checked;
  const base = hasReport ? REPORT_BASE_PRICE_WITH_REPORT : REPORT_BASE_PRICE;
  const total = base + reportOptionsTotal(n);
  const totalOrig = REPORT_BASE_PRICE_ORIG + n * REPORT_OPTION_NOMINAL_PRICE;
  box.innerHTML = `<s>${won(totalOrig)}</s> <strong>${won(total)}</strong>`
    + (n > 0 ? ` <em>(기본 리포트 + 추가 옵션 ${n}개)</em>` : ` <em>(기본 리포트)</em>`)
    + (hasReport ? ` <em>· 결과지 보유 할인 적용</em>` : '');
}

async function submitReportOrder(ev){
  ev.preventDefault();
  const msg = $('#reportFormMsg'); msg.className='form-msg'; msg.textContent='';

  const name = $('#rName').value.trim();
  const phone = $('#rPhone').value.trim();
  const email = $('#rEmail').value.trim();
  if(!name || !phone || !email){ return fail(msg,'이름·연락처·이메일을 모두 입력해 주세요.'); }

  // 입력창에 남아있지만 아직 '추가'를 안 누른 직접입력 옵션은 제출 시 자동으로 포함시킨다
  const leftover = $('#rCustomPersona').value.trim();
  if(leftover){ reportState.customList.push(leftover); $('#rCustomPersona').value=''; renderCustomPersonaList(); }

  const wantReport = $('#rHasReport').checked;
  const file = $('#rReportFile').files[0] || null;
  if(wantReport && !file){
    return fail(msg,'강점 진단 결과지 파일을 업로드해 주세요.');
  }

  const personaList = [...reportState.personas].map(k=> PERSONAS[k].label).concat(reportState.customList);
  const n = reportPersonaCount();
  const hasReport = !!(wantReport && file);
  const basePrice = hasReport ? REPORT_BASE_PRICE_WITH_REPORT : REPORT_BASE_PRICE;
  const addonPrice = reportOptionsTotal(n);
  const total = basePrice + addonPrice;

  const row = {
    customer_name: name,
    customer_phone: phone,
    customer_email: email,
    personas: personaList,
    persona_count: n,
    base_price: basePrice,
    addon_price: addonPrice,
    total_price: total,
    has_report: hasReport,
    status: 'pending'
  };

  const btn = $('#reportSubmitBtn'); btn.disabled=true; btn.textContent='접수 중…';
  try{
    // 결과지 업로드를 결제보다 먼저 — 모바일 리다이렉트 복귀 시 File 객체가 유실되기 때문
    if(hasReport){
      btn.textContent='결과지 업로드 중…';
      row.report_path = await db.uploadReport(file);
    }
    if(PAYMENT_ENABLED){
      btn.textContent='결제 진행 중…';
      stashPendingOrder('report', row);   // 모바일 리다이렉트 복귀용
      try{
        const pay = await requestPortonePayment({
          amount: total, orderName: '미라휴브 강점 리포트',
          customer: { name, phone, email }
        });
        row.payment_id = pay.paymentId;
        row.pay_method = 'card';
        row.payment_status = 'paid'; // ⚠ 서버 검증 전 상태. 추후 Edge Function 검증 연동 필요.
      }catch(pe){
        clearPendingOrder();
        btn.disabled=false; btn.textContent=REPORT_SUBMIT_LABEL;
        if(pe.message==='CHANNEL_NOT_SET' || pe.message==='PORTONE_SDK_MISSING'){
          return fail(msg,'결제 설정이 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        }
        return fail(msg,'결제가 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요.');
      }
    }
    await db.createReportOrder(row);
    clearPendingOrder();
    msg.className='form-msg ok';
    msg.textContent = hasReport
      ? '리포트 신청이 접수되었습니다. 업로드해 주신 결과지를 바탕으로 다음날 리포트를 보내드릴게요. 감사합니다.'
      : (PAYMENT_ENABLED
        ? '결제가 완료되어 리포트 신청이 접수되었습니다. 강점 진단 테스트 코드를 곧 보내드릴게요. 감사합니다.'
        : '리포트 신청이 접수되었습니다. 강점 진단 테스트 코드를 곧 보내드릴게요. 감사합니다.');
    showNotice(msg.textContent);
    $('#reportOrderForm').reset();
    reportState.personas.clear();
    reportState.customList = [];
    $$('#personaPick .persona').forEach(p=> p.classList.remove('active'));
    $('#customPersonaWrap').hidden = true;
    $('#rReportUploadWrap').hidden = true;
    renderCustomPersonaList();
    updateReportPricePreview();
  }catch(err){
    if(err.message==='NOT_CONFIGURED'){
      fail(msg,'신청 시스템이 아직 연결되지 않았습니다. (Supabase 키 입력 필요)');
    } else if(hasReport && !row.report_path){
      fail(msg,'결과지 업로드에 실패했습니다. (Storage \'reports\' 버킷 설정을 확인해 주세요)');
      console.error(err);
    } else {
      fail(msg,'접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      console.error(err);
    }
  }finally{ btn.disabled=false; btn.textContent=REPORT_SUBMIT_LABEL; }
}

/* =========================================================
   관계 리포트(두 사람) 신청 폼
   ========================================================= */
const pairState = { rel:null, org:null };

function pairResolvedRelKey(){
  return pairState.rel === 'org' ? (pairState.org ? `org_${pairState.org}` : null) : pairState.rel;
}

function initPairReportOrder(){
  $$('#relPick .rel').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      pairState.rel = btn.dataset.rel;
      pairState.org = null;
      $$('#relPick .rel').forEach(b=> b.classList.toggle('active', b===btn));
      $('#orgSubPick').hidden = (pairState.rel !== 'org');
      $$('#orgSubPick .org').forEach(b=> b.classList.remove('active'));
      updatePairPersonLabels();
    });
  });
  $$('#orgSubPick .org').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      pairState.org = btn.dataset.org;
      $$('#orgSubPick .org').forEach(b=> b.classList.toggle('active', b===btn));
      updatePairPersonLabels();
    });
  });

  $('#p1HasReport').addEventListener('change', e=>{
    $('#p1ReportUploadWrap').hidden = !e.target.checked;
    if(!e.target.checked) $('#p1ReportFile').value='';
    updatePairPricePreview();
  });
  $('#p2HasReport').addEventListener('change', e=>{
    $('#p2ReportUploadWrap').hidden = !e.target.checked;
    if(!e.target.checked) $('#p2ReportFile').value='';
    updatePairPricePreview();
  });

  updatePairPersonLabels();
  updatePairPricePreview();
  $('#pairOrderForm').addEventListener('submit', submitPairReportOrder);
  const sb=$('#pairSubmitBtn'); if(sb) sb.textContent = PAIR_SUBMIT_LABEL;
}

/* 선택한 관계에 맞춰 "사람 1"/"사람 2" 헤더를 실제 역할 이름으로 바꿔 보여준다. */
function updatePairPersonLabels(){
  const key = pairResolvedRelKey();
  const rel = key && RELATIONSHIPS[key];
  const [a, b] = (rel && rel.roles) || SYMMETRIC_PERSON_LABELS[key] || ['사람 1','사람 2'];
  $('#p1Title').textContent = a;
  $('#p2Title').textContent = b;
}

function updatePairPricePreview(){
  const p1 = $('#p1HasReport').checked, p2 = $('#p2HasReport').checked;
  const total = pairReportPrice(p1, p2);
  const box = $('#pairPricePreview');
  box.innerHTML = `<s>${won(PAIR_REPORT_PRICE_ORIG)}</s> <strong>${won(total)}</strong>`
    + (p1 || p2 ? ` <em>· 결과지 보유 할인 적용</em>` : '');
}

async function submitPairReportOrder(ev){
  ev.preventDefault();
  const msg = $('#pairFormMsg'); msg.className='form-msg'; msg.textContent='';

  const relKey = pairResolvedRelKey();
  if(!relKey){ return fail(msg, pairState.rel==='org' ? '조직 내 관계를 선택해 주세요.' : '두 분의 관계를 선택해 주세요.'); }
  const rel = RELATIONSHIPS[relKey];

  let relationshipLabel = rel.label;
  let p1Role = null, p2Role = null;
  if(rel.roles){
    [p1Role, p2Role] = rel.roles;
    relationshipLabel = `${rel.label} (사람1=${p1Role} · 사람2=${p2Role})`;
  }

  const p1Name=$('#p1Name').value.trim(), p1Phone=$('#p1Phone').value.trim(), p1Email=$('#p1Email').value.trim();
  const p2Name=$('#p2Name').value.trim(), p2Phone=$('#p2Phone').value.trim(), p2Email=$('#p2Email').value.trim();
  if(!p1Name||!p1Phone||!p1Email||!p2Name||!p2Phone||!p2Email){
    return fail(msg,'두 분의 이름·연락처·이메일을 모두 입력해 주세요.');
  }

  const p1Want = $('#p1HasReport').checked, p1File = $('#p1ReportFile').files[0]||null;
  const p2Want = $('#p2HasReport').checked, p2File = $('#p2ReportFile').files[0]||null;
  if(p1Want && !p1File){ return fail(msg,'사람 1의 강점 진단 결과지를 업로드해 주세요.'); }
  if(p2Want && !p2File){ return fail(msg,'사람 2의 강점 진단 결과지를 업로드해 주세요.'); }
  const p1HasReport = !!(p1Want && p1File);
  const p2HasReport = !!(p2Want && p2File);

  const total = pairReportPrice(p1HasReport, p2HasReport);

  const row = {
    relationship_key: relKey,
    relationship_label: relationshipLabel,
    person1_name: p1Name, person1_phone: p1Phone, person1_email: p1Email,
    person1_role: p1Role, person1_has_report: p1HasReport,
    person2_name: p2Name, person2_phone: p2Phone, person2_email: p2Email,
    person2_role: p2Role, person2_has_report: p2HasReport,
    base_price: total,
    total_price: total,
    status: 'pending'
  };

  const btn=$('#pairSubmitBtn'); btn.disabled=true; btn.textContent='접수 중…';
  try{
    // 결과지 업로드를 결제보다 먼저 — 모바일 리다이렉트 복귀 시 File 객체가 유실되기 때문
    if(p1HasReport){ btn.textContent='사람 1 결과지 업로드 중…'; row.person1_report_path = await db.uploadReport(p1File); }
    if(p2HasReport){ btn.textContent='사람 2 결과지 업로드 중…'; row.person2_report_path = await db.uploadReport(p2File); }

    if(PAYMENT_ENABLED){
      btn.textContent='결제 진행 중…';
      stashPendingOrder('pair', row);   // 모바일 리다이렉트 복귀용
      try{
        const pay = await requestPortonePayment({
          amount: total, orderName: '미라휴브 관계 리포트',
          customer: { name:p1Name, phone:p1Phone, email:p1Email }
        });
        row.payment_id = pay.paymentId;
        row.pay_method = 'card';
        row.payment_status = 'paid'; // ⚠ 서버 검증 전 상태. 추후 Edge Function 검증 연동 필요.
      }catch(pe){
        clearPendingOrder();
        btn.disabled=false; btn.textContent=PAIR_SUBMIT_LABEL;
        if(pe.message==='CHANNEL_NOT_SET' || pe.message==='PORTONE_SDK_MISSING'){
          return fail(msg,'결제 설정이 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        }
        return fail(msg,'결제가 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요.');
      }
    }
    await db.createPairReportOrder(row);
    clearPendingOrder();
    msg.className='form-msg ok';
    msg.textContent = PAYMENT_ENABLED
      ? '결제가 완료되어 관계 리포트 신청이 접수되었습니다. 필요한 분께는 강점 진단 테스트 코드를 곧 보내드릴게요. 감사합니다.'
      : '관계 리포트 신청이 접수되었습니다. 필요한 분께는 강점 진단 테스트 코드를 곧 보내드릴게요. 감사합니다.';
    showNotice(msg.textContent);
    $('#pairOrderForm').reset();
    pairState.rel=null; pairState.org=null;
    $$('#relPick .rel,#orgSubPick .org').forEach(b=> b.classList.remove('active'));
    $('#orgSubPick').hidden = true;
    updatePairPersonLabels();
    $('#p1ReportUploadWrap').hidden = true;
    $('#p2ReportUploadWrap').hidden = true;
    updatePairPricePreview();
  }catch(err){
    if(err.message==='NOT_CONFIGURED'){
      fail(msg,'신청 시스템이 아직 연결되지 않았습니다. (Supabase 키 입력 필요)');
    } else if((p1HasReport && !row.person1_report_path) || (p2HasReport && !row.person2_report_path)){
      fail(msg,'결과지 업로드에 실패했습니다. (Storage \'reports\' 버킷 설정을 확인해 주세요)');
      console.error(err);
    } else {
      fail(msg,'접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      console.error(err);
    }
  }finally{ btn.disabled=false; btn.textContent=PAIR_SUBMIT_LABEL; }
}

/* =========================================================
   어드민
   ========================================================= */
let adminAuthed = false;
let currentFilter = 'all';
let currentReportFilter = 'all';
let currentPairReportFilter = 'all';

function initAdmin(){
  window.addEventListener('hashchange', handleHash);
  handleHash();
  $('#adminClose').addEventListener('click', ()=>{ location.hash=''; });
  $('#adminLoginBtn').addEventListener('click', adminLogin);
  $('#adminPw').addEventListener('keydown', e=>{ if(e.key==='Enter') adminLogin(); });
  $('#adminLogout')?.addEventListener('click', async ()=>{ await sbClient?.auth.signOut(); });

  // 세션 복원 + 로그인 상태 변화 반영 (Supabase Auth)
  if(CONFIGURED && sbClient){
    sbClient.auth.getSession().then(({data})=> applyAuth(data.session));
    sbClient.auth.onAuthStateChange((_ev, session)=> applyAuth(session));
  }

  $$('.atab').forEach(t=> t.addEventListener('click', ()=>{
    $$('.atab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
    const tab=t.dataset.tab;
    $('#panelBookings').hidden = tab!=='bookings';
    $('#panelReports').hidden = tab!=='reports';
    $('#panelPairReports').hidden = tab!=='pairReports';
    $('#panelBlocks').hidden = tab!=='blocks';
    if(tab==='bookings') loadBookings();
    if(tab==='blocks') loadBlocks();
    if(tab==='reports') loadReportOrders();
    if(tab==='pairReports') loadPairReportOrders();
  }));
  $$('#statusFilter .fbtn').forEach(b=> b.addEventListener('click', ()=>{
    $$('#statusFilter .fbtn').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    currentFilter=b.dataset.status; renderBookings();
  }));
  $$('#reportStatusFilter .fbtn').forEach(b=> b.addEventListener('click', ()=>{
    $$('#reportStatusFilter .fbtn').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    currentReportFilter=b.dataset.status; renderReportOrders();
  }));
  $$('#pairReportStatusFilter .fbtn').forEach(b=> b.addEventListener('click', ()=>{
    $$('#pairReportStatusFilter .fbtn').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    currentPairReportFilter=b.dataset.status; renderPairReportOrders();
  }));
  $('#calPrev').addEventListener('click', ()=> shiftMonth(-1));
  $('#calNext').addEventListener('click', ()=> shiftMonth(1));
  $('#fullDayBtn').addEventListener('click', toggleFullDay);
  $('#historyClose').addEventListener('click', ()=> $('#historyModal').hidden=true);
}

function handleHash(){
  const open = location.hash === '#admin';
  $('#adminScreen').hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
  if(open && adminAuthed) loadBookings();
}

/* 로그인 세션 유무에 따라 로그인/대시보드 화면 전환 */
function applyAuth(session){
  adminAuthed = !!session;
  $('#adminLogin').hidden = adminAuthed;
  $('#adminDash').hidden = !adminAuthed;
  $('#adminLogout')?.toggleAttribute('hidden', !adminAuthed);
  const msg = $('#adminLoginMsg'); if(msg && adminAuthed) msg.textContent = '';
  if(adminAuthed && location.hash === '#admin') loadBookings();
}

async function adminLogin(){
  const msg=$('#adminLoginMsg'); msg.className='form-msg';
  if(!CONFIGURED || !sbClient){ msg.className='form-msg err'; msg.textContent='Supabase 설정이 필요합니다.'; return; }
  const email = ($('#adminEmail')?.value || '').trim();
  const password = $('#adminPw').value;
  if(!email || !password){ msg.className='form-msg err'; msg.textContent='이메일과 비밀번호를 입력해 주세요.'; return; }
  msg.textContent = '로그인 중…';
  const { error } = await sbClient.auth.signInWithPassword({ email, password });
  if(error){ msg.className='form-msg err'; msg.textContent='이메일 또는 비밀번호가 올바르지 않습니다.'; return; }
  // 성공 시 onAuthStateChange → applyAuth가 대시보드로 전환
}

let allBookings = [];
async function loadBookings(){
  const list=$('#bookingList'); list.innerHTML='<p class="muted">불러오는 중…</p>';
  if(!CONFIGURED){ list.innerHTML='<p class="muted">Supabase 키 입력 후 이용할 수 있습니다.</p>'; return; }
  try{
    allBookings = await db.listBookings();
    const cancelled = await sweepAutoCancel();   // 코드포함(테스트) 미완료 + 마감 지남 → 자동취소
    if(cancelled>0) allBookings = await db.listBookings();
    renderBookings();
    const note=$('#sweepNote');
    if(note){ note.hidden = !(cancelled>0); if(cancelled>0) note.textContent=`⚠ 테스트 미완료로 자동 취소된 예약 ${cancelled}건이 있습니다.`; }
  }
  catch(e){ list.innerHTML='<p class="muted">불러오기 실패. 테이블/키 설정을 확인해 주세요.</p>'; console.error(e); }
}

/* 코드포함(테스트)만 24시간 자동취소. 코드별도는 예약 시 결과지 업로드 완료라 제외. */
async function sweepAutoCancel(){
  const due = allBookings.filter(b =>
    (b.status==='pending'||b.status==='confirmed') && !b.has_report && !b.prep_done && Date.now()>=deadlineMs(b)
  );
  for(const b of due){
    try{ await db.updateBooking(b.id, { status:'cancelled', cancel_reason:'자동 취소 · 상담 24시간 전까지 테스트 미완료' }); }
    catch(e){ console.error(e); }
  }
  return due.length;
}

function renderBookings(){
  const list=$('#bookingList');
  const rows = currentFilter==='all' ? allBookings : allBookings.filter(b=>b.status===currentFilter);
  if(!rows.length){ list.innerHTML='<p class="muted">예약이 없습니다.</p>'; return; }
  list.innerHTML='';
  rows.forEach(b=> list.appendChild(bookingCard(b)));
}

function bookingCard(b){
  const dow = DOW[parseDate(b.booking_date).getDay()];
  const active = (b.status==='pending'||b.status==='confirmed');

  // 준비물 상태 (대기·확정에만)
  let prepHtml='';
  if(active){
    if(b.has_report){
      prepHtml = `<div class="bk-prep ok">📎 코드 별도 결제 · 예약 시 결과지 업로드 완료</div>`;
    } else {
      prepHtml = b.prep_done
        ? `<div class="bk-prep ok">✓ 코드 포함 결제 · 테스트 완료 확인됨</div>`
        : `<div class="bk-prep wait">· 코드 포함 결제 · 테스트 완료 대기 중</div>`;
      const dl=deadlineMs(b), over=Date.now()>=dl;
      prepHtml += `<div class="bk-deadline${over?' over':''}">취소 마감 · ${fmtDateTime(dl)} ${relText(dl)}</div>`;
    }
  }
  const reasonHtml = (b.status==='cancelled' && b.cancel_reason)
    ? `<div class="bk-cancelreason">⚠ ${esc(b.cancel_reason)}</div>` : '';
  const prepBtn = (active && !b.has_report)
    ? `<button class="mini-btn ghost act-prep">${b.prep_done?'확인 취소':'테스트 완료 표시'}</button>` : '';

  const el=document.createElement('div');
  el.className=`bk-card s-${b.status}`;
  el.innerHTML = `
    <div class="bk-top">
      <div>
        <div class="bk-name">${esc(b.customer_name)}</div>
        <div class="bk-svc">${esc(b.service_label)} · ${b.duration_min}분</div>
      </div>
      <span class="bk-badge">${STATUS_LABEL[b.status]||b.status}</span>
    </div>
    <div class="bk-when">📅 ${b.booking_date} (${dow}) ${b.booking_time}</div>
    <div class="bk-contact">${esc(b.customer_phone)} · ${esc(b.customer_email)}</div>
    ${priceRow(b)}
    ${prepHtml}
    ${reasonHtml}
    <div class="bk-purpose"><strong>${esc(b.purpose||'')}</strong>${b.purpose_detail?' — '+esc(b.purpose_detail):''}</div>
    <div class="bk-actions">
      <select class="st-sel">
        ${['pending','confirmed','completed','cancelled'].map(s=>`<option value="${s}" ${s===b.status?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
      ${prepBtn}
      <button class="mini-btn act-mail">Gmail 메일</button>
      <button class="mini-btn ghost act-hist">고객 이력</button>
      ${b.report_path?'<button class="mini-btn ghost act-report">결과지 보기</button>':''}
    </div>
    <div class="bk-memo">
      <textarea rows="2" placeholder="고객 메모…">${esc(b.memo||'')}</textarea>
      <button class="mini-btn ghost act-memo" style="margin-top:6px;">메모 저장</button>
    </div>`;

  el.querySelector('.st-sel').addEventListener('change', async e=>{
    const ns=e.target.value;
    try{
      await db.updateBooking(b.id,{status:ns}); b.status=ns;
      el.className=`bk-card s-${b.status}`; el.querySelector('.bk-badge').textContent=STATUS_LABEL[b.status];
      if(ns==='confirmed') openMail(b,'confirmed');   // 확정 시 안내메일 자동 작성
      renderBookings();
    }catch(err){ alert('상태 변경 실패'); console.error(err); }
  });
  const prepEl=el.querySelector('.act-prep');
  if(prepEl) prepEl.addEventListener('click', async ()=>{
    const nv=!b.prep_done;
    try{ await db.updateBooking(b.id,{prep_done:nv}); b.prep_done=nv; renderBookings(); }
    catch(err){ alert('준비 상태 변경 실패'); console.error(err); }
  });
  el.querySelector('.act-memo').addEventListener('click', async ()=>{
    const v=el.querySelector('textarea').value;
    try{ await db.updateBooking(b.id,{memo:v}); b.memo=v; flash(el.querySelector('.act-memo'),'저장됨'); }
    catch(err){ alert('메모 저장 실패'); console.error(err); }
  });
  el.querySelector('.act-mail').addEventListener('click', ()=> openMail(b, mailType(b.status)));
  el.querySelector('.act-hist').addEventListener('click', ()=> showHistory(b.customer_email, b.customer_name));
  const repBtn = el.querySelector('.act-report');
  if(repBtn){
    repBtn.addEventListener('click', async ()=>{
      repBtn.disabled=true; const o=repBtn.textContent; repBtn.textContent='여는 중…';
      try{ const url = await db.reportSignedUrl(b.report_path); window.open(url,'_blank'); }
      catch(e){ alert('결과지를 열 수 없습니다. Storage 설정을 확인해 주세요.'); console.error(e); }
      finally{ repBtn.disabled=false; repBtn.textContent=o; }
    });
  }
  return el;
}

/* 결제 금액 줄 (어드민) */
function priceRow(b){
  if(b.final_price == null && b.base_price == null) return '';
  const paidTag = b.payment_status==='paid'
    ? ` · <span style="color:#1a7a4a;font-weight:600;">결제완료${b.pay_method?'('+({card:'카드',kakaopay:'카카오페이',naverpay:'네이버페이'}[b.pay_method]||b.pay_method)+')':''}</span>`
    : '';
  if(b.discount_rate > 0){
    return `<div class="bk-price">💳 <strong>${won(b.final_price)}</strong> <span class="bk-strike">${won(b.base_price)}</span> · 결과지 40% 할인${b.report_path?' · 결과지 첨부됨':''}${paidTag}</div>`;
  }
  return `<div class="bk-price">💳 ${won(b.final_price!=null?b.final_price:b.base_price)}${paidTag}</div>`;
}

function flash(btn,t){ const o=btn.textContent; btn.textContent=t; setTimeout(()=>btn.textContent=o,1200); }

/* =========================================================
   리포트 주문 (어드민)
   ========================================================= */
let allReportOrders = [];
async function loadReportOrders(){
  const list=$('#reportOrderList'); list.innerHTML='<p class="muted">불러오는 중…</p>';
  if(!CONFIGURED){ list.innerHTML='<p class="muted">Supabase 키 입력 후 이용할 수 있습니다.</p>'; return; }
  try{ allReportOrders = await db.listReportOrders(); renderReportOrders(); }
  catch(e){ list.innerHTML='<p class="muted">불러오기 실패. 테이블/키 설정을 확인해 주세요.</p>'; console.error(e); }
}

function renderReportOrders(){
  const list=$('#reportOrderList');
  const rows = currentReportFilter==='all' ? allReportOrders : allReportOrders.filter(o=>o.status===currentReportFilter);
  if(!rows.length){ list.innerHTML='<p class="muted">리포트 신청이 없습니다.</p>'; return; }
  list.innerHTML='';
  rows.forEach(o=> list.appendChild(reportOrderCard(o)));
}

function reportOrderCard(o){
  const active = (o.status==='pending'||o.status==='confirmed');
  const personas = (o.personas||[]).length ? (o.personas||[]).join(', ') : '없음';
  const paidTag = o.payment_status==='paid'
    ? ` · <span style="color:#1a7a4a;font-weight:600;">결제완료</span>` : '';
  const prepHtml = o.has_report
    ? `<div class="bk-prep ok">📎 결과지 업로드 완료 · 테스트코드 발송·테스트완료 단계 생략</div>`
    : (active
      ? (o.prep_done
          ? `<div class="bk-prep ok">✓ 테스트 완료 확인됨</div>`
          : `<div class="bk-prep wait">· 테스트 완료 대기 중</div>`)
      : '');
  const prepBtn = (active && !o.has_report)
    ? `<button class="mini-btn ghost act-prep">${o.prep_done?'확인 취소':'테스트 완료 표시'}</button>` : '';
  const reportBtn = o.report_path ? `<button class="mini-btn ghost act-report">결과지 보기</button>` : '';

  const el=document.createElement('div');
  el.className=`bk-card s-${o.status}`;
  el.innerHTML = `
    <div class="bk-top">
      <div>
        <div class="bk-name">${esc(o.customer_name)}</div>
        <div class="bk-svc">강점 리포트 · 추가 옵션 ${o.persona_count||0}개</div>
      </div>
      <span class="bk-badge">${STATUS_LABEL[o.status]||o.status}</span>
    </div>
    <div class="bk-contact">${esc(o.customer_phone)} · ${esc(o.customer_email)}</div>
    <div class="bk-price">💳 <strong>${won(o.total_price)}</strong>${paidTag}</div>
    <div class="bk-purpose"><strong>추가 옵션</strong> — ${esc(personas)}</div>
    ${prepHtml}
    <div class="bk-actions">
      <select class="st-sel">
        ${['pending','confirmed','completed','cancelled'].map(s=>`<option value="${s}" ${s===o.status?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
      ${prepBtn}
      <button class="mini-btn act-mail">Gmail 메일</button>
      ${reportBtn}
    </div>
    <div class="bk-memo">
      <textarea rows="2" placeholder="고객 메모…">${esc(o.memo||'')}</textarea>
      <button class="mini-btn ghost act-memo" style="margin-top:6px;">메모 저장</button>
    </div>`;

  el.querySelector('.st-sel').addEventListener('change', async e=>{
    const ns=e.target.value;
    try{
      await db.updateReportOrder(o.id,{status:ns}); o.status=ns;
      el.className=`bk-card s-${o.status}`; el.querySelector('.bk-badge').textContent=STATUS_LABEL[o.status];
      renderReportOrders();
    }catch(err){ alert('상태 변경 실패'); console.error(err); }
  });
  const prepEl=el.querySelector('.act-prep');
  if(prepEl) prepEl.addEventListener('click', async ()=>{
    const nv=!o.prep_done;
    try{ await db.updateReportOrder(o.id,{prep_done:nv}); o.prep_done=nv; renderReportOrders(); }
    catch(err){ alert('상태 변경 실패'); console.error(err); }
  });
  el.querySelector('.act-memo').addEventListener('click', async ()=>{
    const v=el.querySelector('textarea').value;
    try{ await db.updateReportOrder(o.id,{memo:v}); o.memo=v; flash(el.querySelector('.act-memo'),'저장됨'); }
    catch(err){ alert('메모 저장 실패'); console.error(err); }
  });
  el.querySelector('.act-mail').addEventListener('click', ()=>{
    const w = window.open(buildReportMail(o), '_blank');
    if(!w) alert('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용하면 메일 작성창이 열립니다.');
  });
  const repBtn = el.querySelector('.act-report');
  if(repBtn){
    repBtn.addEventListener('click', async ()=>{
      repBtn.disabled=true; const o2=repBtn.textContent; repBtn.textContent='여는 중…';
      try{ const url = await db.reportSignedUrl(o.report_path); window.open(url,'_blank'); }
      catch(e){ alert('결과지를 열 수 없습니다. Storage 설정을 확인해 주세요.'); console.error(e); }
      finally{ repBtn.disabled=false; repBtn.textContent=o2; }
    });
  }
  return el;
}

/* 리포트 신청 접수 메일(Gmail compose) */
function buildReportMail(o){
  const personas = (o.personas||[]).length ? (o.personas||[]).join(', ') : '없음';
  const subject = `[MIRA HUVE] 강점 리포트 신청이 접수되었습니다`;
  const guide = o.has_report
    ? [ `보내주신 강점 진단(갤럽 CliftonStrengths 34개 전체) 결과지를 잘 받았습니다.`,
        `별도의 테스트 코드 발송·진단 없이, 보내주신 결과를 바탕으로 다음날 리포트를 만들어 보내드립니다.` ]
    : [ `리포트 생성을 위해 강점 진단(갤럽 CliftonStrengths) 테스트 코드를 곧 보내드립니다.`,
        `코드를 받으시면 진단을 완료해 주세요. 완료된 결과를 바탕으로 리포트를 만들어 보내드립니다.` ];
  const lines = [
    `안녕하세요, ${o.customer_name} 님.`,
    `강점 리포트 신청이 접수되었습니다. 아래 내용을 확인해 주세요.`,
    ``,
    `추가 옵션 · ${personas}`,
    `결제 금액 · ${won(o.total_price)}`,
    ``,
    ...guide,
    ``,
    `세상은 바꿀 수 없지만, 당신의 세상은 바꿀 수 있습니다.`,
    `MIRA HUVE`
  ];
  return 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(o.customer_email)
    + '&su=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(lines.join('\n'));
}

/* =========================================================
   관계 리포트 주문 (어드민)
   ========================================================= */
let allPairReportOrders = [];
async function loadPairReportOrders(){
  const list=$('#pairReportOrderList'); list.innerHTML='<p class="muted">불러오는 중…</p>';
  if(!CONFIGURED){ list.innerHTML='<p class="muted">Supabase 키 입력 후 이용할 수 있습니다.</p>'; return; }
  try{ allPairReportOrders = await db.listPairReportOrders(); renderPairReportOrders(); }
  catch(e){ list.innerHTML='<p class="muted">불러오기 실패. 테이블/키 설정을 확인해 주세요.</p>'; console.error(e); }
}

function renderPairReportOrders(){
  const list=$('#pairReportOrderList');
  const rows = currentPairReportFilter==='all' ? allPairReportOrders : allPairReportOrders.filter(o=>o.status===currentPairReportFilter);
  if(!rows.length){ list.innerHTML='<p class="muted">관계 리포트 신청이 없습니다.</p>'; return; }
  list.innerHTML='';
  rows.forEach(o=> list.appendChild(pairReportOrderCard(o)));
}

function personPrepLine(name, role, hasReport){
  const roleTag = role ? ` (${esc(role)})` : '';
  return hasReport
    ? `<div class="bk-prep ok">📎 ${esc(name)}${roleTag} · 결과지 업로드 완료</div>`
    : `<div class="bk-prep wait">· ${esc(name)}${roleTag} · 테스트 코드 발송 대상</div>`;
}

function pairReportOrderCard(o){
  const paidTag = o.payment_status==='paid'
    ? ` · <span style="color:#1a7a4a;font-weight:600;">결제완료</span>` : '';
  const rep1Btn = o.person1_report_path ? `<button class="mini-btn ghost act-report1">사람1 결과지</button>` : '';
  const rep2Btn = o.person2_report_path ? `<button class="mini-btn ghost act-report2">사람2 결과지</button>` : '';

  const el=document.createElement('div');
  el.className=`bk-card s-${o.status}`;
  el.innerHTML = `
    <div class="bk-top">
      <div>
        <div class="bk-name">${esc(o.person1_name)} · ${esc(o.person2_name)}</div>
        <div class="bk-svc">관계 리포트 · ${esc(o.relationship_label)}</div>
      </div>
      <span class="bk-badge">${STATUS_LABEL[o.status]||o.status}</span>
    </div>
    <div class="bk-contact">사람1 · ${esc(o.person1_phone)} · ${esc(o.person1_email)}</div>
    <div class="bk-contact">사람2 · ${esc(o.person2_phone)} · ${esc(o.person2_email)}</div>
    <div class="bk-price">💳 <strong>${won(o.total_price)}</strong>${paidTag}</div>
    ${personPrepLine(o.person1_name, o.person1_role, o.person1_has_report)}
    ${personPrepLine(o.person2_name, o.person2_role, o.person2_has_report)}
    <div class="bk-actions">
      <select class="st-sel">
        ${['pending','confirmed','completed','cancelled'].map(s=>`<option value="${s}" ${s===o.status?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
      <button class="mini-btn act-mail1">사람1 메일</button>
      <button class="mini-btn act-mail2">사람2 메일</button>
      ${rep1Btn}
      ${rep2Btn}
    </div>
    <div class="bk-memo">
      <textarea rows="2" placeholder="고객 메모…">${esc(o.memo||'')}</textarea>
      <button class="mini-btn ghost act-memo" style="margin-top:6px;">메모 저장</button>
    </div>`;

  el.querySelector('.st-sel').addEventListener('change', async e=>{
    const ns=e.target.value;
    try{
      await db.updatePairReportOrder(o.id,{status:ns}); o.status=ns;
      el.className=`bk-card s-${o.status}`; el.querySelector('.bk-badge').textContent=STATUS_LABEL[o.status];
      renderPairReportOrders();
    }catch(err){ alert('상태 변경 실패'); console.error(err); }
  });
  el.querySelector('.act-memo').addEventListener('click', async ()=>{
    const v=el.querySelector('textarea').value;
    try{ await db.updatePairReportOrder(o.id,{memo:v}); o.memo=v; flash(el.querySelector('.act-memo'),'저장됨'); }
    catch(err){ alert('메모 저장 실패'); console.error(err); }
  });
  el.querySelector('.act-mail1').addEventListener('click', ()=>{
    const w = window.open(buildPairReportMail(o,1), '_blank');
    if(!w) alert('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용하면 메일 작성창이 열립니다.');
  });
  el.querySelector('.act-mail2').addEventListener('click', ()=>{
    const w = window.open(buildPairReportMail(o,2), '_blank');
    if(!w) alert('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용하면 메일 작성창이 열립니다.');
  });
  const rep1El = el.querySelector('.act-report1');
  if(rep1El) rep1El.addEventListener('click', async ()=>{
    rep1El.disabled=true; const t=rep1El.textContent; rep1El.textContent='여는 중…';
    try{ const url = await db.reportSignedUrl(o.person1_report_path); window.open(url,'_blank'); }
    catch(e){ alert('결과지를 열 수 없습니다. Storage 설정을 확인해 주세요.'); console.error(e); }
    finally{ rep1El.disabled=false; rep1El.textContent=t; }
  });
  const rep2El = el.querySelector('.act-report2');
  if(rep2El) rep2El.addEventListener('click', async ()=>{
    rep2El.disabled=true; const t=rep2El.textContent; rep2El.textContent='여는 중…';
    try{ const url = await db.reportSignedUrl(o.person2_report_path); window.open(url,'_blank'); }
    catch(e){ alert('결과지를 열 수 없습니다. Storage 설정을 확인해 주세요.'); console.error(e); }
    finally{ rep2El.disabled=false; rep2El.textContent=t; }
  });
  return el;
}

/* 관계 리포트 접수 메일(Gmail compose) — 두 사람에게 각각 보낸다 */
function buildPairReportMail(o, personNum){
  const isP1 = personNum===1;
  const name = isP1 ? o.person1_name : o.person2_name;
  const email = isP1 ? o.person1_email : o.person2_email;
  const role = isP1 ? o.person1_role : o.person2_role;
  const hasReport = isP1 ? o.person1_has_report : o.person2_has_report;
  const otherName = isP1 ? o.person2_name : o.person1_name;
  const subject = `[MIRA HUVE] 관계 리포트 신청이 접수되었습니다`;
  const guide = hasReport
    ? [ `보내주신 강점 진단(갤럽 CliftonStrengths 34개 전체) 결과지를 잘 받았습니다.` ]
    : [ `리포트 생성을 위해 강점 진단(갤럽 CliftonStrengths) 테스트 코드를 곧 보내드립니다.`,
        `코드를 받으시면 진단을 완료해 주세요.` ];
  const lines = [
    `안녕하세요, ${name} 님.`,
    `${otherName} 님과 함께 신청하신 관계 리포트가 접수되었습니다.`,
    ``,
    `관계 · ${o.relationship_label}${role ? ' · 역할: '+role : ''}`,
    ``,
    ...guide,
    `두 분의 결과가 모두 준비되면, 강점이 서로 어떻게 부딪히고 보완되는지 담은 리포트를 만들어 보내드립니다.`,
    ``,
    `세상은 바꿀 수 없지만, 당신의 세상은 바꿀 수 있습니다.`,
    `MIRA HUVE`
  ];
  return 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(email)
    + '&su=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(lines.join('\n'));
}

/* 고객 이력 */
async function showHistory(email,name){
  $('#historyTitle').textContent = `${name} 님의 예약 이력`;
  const body=$('#historyBody'); body.innerHTML='<p class="muted">불러오는 중…</p>';
  $('#historyModal').hidden=false;
  try{
    const rows = await db.customerHistory(email);
    if(!rows.length){ body.innerHTML='<p class="muted">이력이 없습니다.</p>'; return; }
    body.innerHTML = rows.map(r=>{
      const dow=DOW[parseDate(r.booking_date).getDay()];
      return `<div class="hist-item">
        <div class="hist-when">${r.booking_date} (${dow}) ${r.booking_time} · ${STATUS_LABEL[r.status]||r.status}</div>
        <div class="hist-meta">${esc(r.service_label)} · ${r.duration_min}분${r.purpose?' · '+esc(r.purpose):''}</div>
      </div>`;
    }).join('');
  }catch(e){ body.innerHTML='<p class="muted">불러오기 실패.</p>'; console.error(e); }
}

/* =========================================================
   시간 차단 — 달력 → 날짜 선택 → 시간 선택
   ========================================================= */
const BLOCK_TIMES = (()=>{ const a=[]; for(let h=9;h<=20;h++){ a.push(`${String(h).padStart(2,'0')}:00`); if(h<20) a.push(`${String(h).padStart(2,'0')}:30`); } return a; })();
let calY, calM, selDate=null, allBlocks=[];

function shiftMonth(d){ calM+=d; if(calM<0){calM=11;calY--;} else if(calM>11){calM=0;calY++;} renderCalendar(); }

async function loadBlocks(){
  const list=$('#blockList');
  if(!CONFIGURED){ list.innerHTML='<p class="muted">Supabase 키 입력 후 이용할 수 있습니다.</p>'; $('#calGrid').innerHTML=''; return; }
  if(calY===undefined){ const n=new Date(); calY=n.getFullYear(); calM=n.getMonth(); }
  try{ allBlocks = await db.listBlocks(); }catch(e){ allBlocks=[]; console.error(e); }
  renderCalendar();
  if(selDate) renderDayPanel();
  renderBlockList();
}

const blocksForDate = date => allBlocks.filter(b=> b.block_date===date);
const isFullDay = date => blocksForDate(date).some(b=> !b.block_time);

function renderCalendar(){
  $('#calLabel').textContent = `${calY}년 ${calM+1}월`;
  const grid=$('#calGrid'); grid.innerHTML='';
  ['일','월','화','수','목','금','토'].forEach(d=>{ const h=document.createElement('div'); h.className='cal-dow'; h.textContent=d; grid.appendChild(h); });
  const first=new Date(calY,calM,1).getDay(), days=new Date(calY,calM+1,0).getDate();
  const today=new Date(); today.setHours(0,0,0,0);
  for(let i=0;i<first;i++){ const e=document.createElement('div'); e.className='cal-cell empty'; grid.appendChild(e); }
  for(let d=1;d<=days;d++){
    const dt=new Date(calY,calM,d), ds=dateStr(dt), dow=dt.getDay();
    const cell=document.createElement('div');
    cell.className='cal-cell'+(dow===0?' sun':dow===6?' sat':'');
    if(dt<today) cell.classList.add('past');
    if(dt.getTime()===today.getTime()) cell.classList.add('today');
    if(ds===selDate) cell.classList.add('sel');
    if(isFullDay(ds)) cell.classList.add('fullblock');
    cell.innerHTML=`${d}`+(blocksForDate(ds).length?'<span class="cal-dot"></span>':'');
    if(dt>=today) cell.addEventListener('click', ()=> selectDay(ds));
    grid.appendChild(cell);
  }
}

function selectDay(ds){ selDate=ds; renderCalendar(); renderDayPanel(); }

async function renderDayPanel(){
  const panel=$('#blockDay'); panel.hidden=false;
  const dt=parseDate(selDate);
  $('#blockDayLabel').textContent = `${selDate} (${DOW[dt.getDay()]}) 차단 설정`;
  const full=isFullDay(selDate);
  const fbtn=$('#fullDayBtn'); fbtn.textContent= full?'종일 차단 해제':'종일 차단'; fbtn.classList.toggle('on', full);

  const grid=$('#timeGrid'); grid.innerHTML='<span class="muted" style="font-size:13px;">시간 불러오는 중…</span>';
  let booked=[]; try{ booked=await db.bookingsOnDate(selDate); }catch(e){}
  const blockedTimes=new Set(blocksForDate(selDate).filter(b=>b.block_time).map(b=>b.block_time));
  grid.innerHTML=''; grid.classList.toggle('disabled', full);
  BLOCK_TIMES.forEach(t=>{
    const m=toMin(t);
    const isBooked=booked.some(bk=>{ const s=toMin(bk.booking_time); return m>=s && m<s+(bk.duration_min||60); });
    const isBlocked=blockedTimes.has(t);
    const chip=document.createElement('button'); chip.type='button';
    chip.className='tchip'+(isBlocked?' blocked':'')+(isBooked&&!isBlocked?' booked':'');
    chip.textContent=t;
    if(isBooked && !isBlocked){ chip.disabled=true; chip.title='예약 있음'; }
    else chip.addEventListener('click', ()=> toggleTime(selDate,t,isBlocked));
    grid.appendChild(chip);
  });
}

async function toggleTime(date,time,isBlocked){
  try{
    if(isBlocked){ const row=blocksForDate(date).find(b=>b.block_time===time); if(row) await db.removeBlock(row.id); }
    else { await db.addBlock({ block_date:date, block_time:time, reason:$('#blkReason').value.trim()||null }); }
    await loadBlocks();
  }catch(e){ alert('차단 변경 실패'); console.error(e); }
}

async function toggleFullDay(){
  if(!selDate){ alert('날짜를 먼저 선택해 주세요.'); return; }
  try{
    if(isFullDay(selDate)){ const row=blocksForDate(selDate).find(b=>!b.block_time); if(row) await db.removeBlock(row.id); }
    else { await db.addBlock({ block_date:selDate, block_time:null, reason:$('#blkReason').value.trim()||null }); }
    await loadBlocks();
  }catch(e){ alert('종일 차단 변경 실패'); console.error(e); }
}

function renderBlockList(){
  const list=$('#blockList');
  if(!allBlocks.length){ list.innerHTML='<p class="muted">차단된 시간이 없습니다.</p>'; return; }
  list.innerHTML='<p class="muted" style="margin-bottom:8px;">전체 차단 목록</p>';
  allBlocks.forEach(r=>{
    const el=document.createElement('div'); el.className='blk-card';
    el.innerHTML=`<div><strong>${r.block_date}</strong> ${r.block_time?r.block_time:'(종일)'} ${r.reason?'· '+esc(r.reason):''}</div>
      <button class="mini-btn ghost">삭제</button>`;
    el.querySelector('button').addEventListener('click', async ()=>{
      if(!confirm('이 차단을 삭제할까요?')) return;
      try{ await db.removeBlock(r.id); await loadBlocks(); }catch(e){ alert('삭제 실패'); }
    });
    list.appendChild(el);
  });
}

/* 메일 종류: 확정이면 확정메일, 그 외엔 접수메일 */
function mailType(status){ return status==='confirmed' ? 'confirmed' : 'received'; }
function openMail(b, type){
  const w = window.open(buildMail(b, type), '_blank');
  if(!w) alert('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용하면 메일 작성창이 열립니다.');
}

/* 접수/확정 메일(Gmail compose) */
function buildMail(b, type='received'){
  const dow = DOW[parseDate(b.booking_date).getDay()];
  const confirmed = type==='confirmed';
  const subject = confirmed
    ? `[MIRA HUVE] 예약이 확정되었습니다 · ${b.service_label}`
    : `[MIRA HUVE] 예약이 접수되었습니다 · ${b.service_label}`;
  const intro = confirmed
    ? `요청하신 일정으로 상담 예약이 확정되었습니다. 아래 내용을 확인해 주세요.`
    : `아래 내용으로 예약이 접수되었으며, 확정 안내는 곧 다시 메일로 전해드립니다.`;
  let guide;
  if(b.has_report){
    guide = [ `보내주신 강점 진단 결과지를 잘 받았습니다. 이 결과를 바탕으로 상담을 준비합니다.`,
              `결과지 제출 혜택으로 상담비 40% 할인이 적용되었습니다.` ];
  } else {
    guide = confirmed
      ? [ `상담 전까지 강점 진단(갤럽 CliftonStrengths)을 완료해 주세요.`,
          `테스트는 30~40분 방해받지 않는 시간이 필요합니다.` ]
      : [ `상담 진행을 위해 강점 진단(갤럽 CliftonStrengths) 테스트 코드를 곧 보내드립니다.`,
          `코드를 받으시면 진단을 완료해 주세요. 결과 리포트를 바탕으로 상담을 준비합니다.` ];
  }
  const costLine = (b.discount_rate > 0)
    ? `비용 · ${won(b.final_price)} (정가 ${won(b.base_price)}에서 40% 할인 적용)`
    : `비용 · ${b.final_price!=null||b.base_price!=null ? won(b.final_price!=null?b.final_price:b.base_price) : '상담 후 안내'}`;
  // 코드포함(테스트) 고객에게만 24시간 전 테스트 미완료 자동취소 안내
  const cancelNote = b.has_report
    ? `변경 또는 취소는 상담 24시간 전까지 가능합니다.`
    : `상담 24시간 전까지 테스트를 마치지 않으면 상담은 취소됩니다. 변경 또는 취소도 상담 24시간 전까지 가능합니다.`;
  const lines = [
    `안녕하세요, ${b.customer_name} 님.`,
    intro,
    ``,
    `예약 서비스 · ${b.service_label} (${b.duration_min}분)`,
    `예약 일시 · ${b.booking_date} (${dow}) ${b.booking_time}`,
    `진행 장소 · {대면 주소 또는 화상 링크}`,
    costLine,
    ``,
    ...guide,
    cancelNote,
    ``,
    `세상은 바꿀 수 없지만, 당신의 세상은 바꿀 수 있습니다.`,
    `MIRA HUVE`
  ];
  return 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(b.customer_email)
    + '&su=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(lines.join('\n'));
}

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ---- 시작 ---- */
document.addEventListener('DOMContentLoaded', ()=>{
  // app.js는 index.html·report-apply.html·pair-report-apply.html이 공유한다 — 각 페이지에 실제로 있는 요소만 초기화한다
  if($('#navToggle') || $('#navLinks')) initNav();
  if($('.domain-card')) initDomainFlip();
  if($('#bookingForm')) initBooking();
  if($('#reportOrderForm')) initReportOrder();
  if($('#pairOrderForm')) initPairReportOrder();
  if($('#adminScreen')) initAdmin();
  // 이메일 mailto 조합 (평문 노출/난독화 방지)
  const em = document.getElementById('emailLink');
  if(em){ em.href = 'mailto:' + em.dataset.user + '@' + em.dataset.domain; }
  // 모바일 결제 리다이렉트 복귀 처리 — 주소창의 paymentId/code를 읽어 접수를 마저 완료
  handlePaymentRedirect();
});
