/* =========================================================
   MIRA HUVE — app.js
   설정(아래 두 줄)만 채우면 예약/어드민이 작동합니다.
   ========================================================= */
const SUPABASE_URL = 'https://ilcgpjxzlaoeuzmezvft.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsY2dwanh6bGFvZXV6bWV6dmZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MDg3OTYsImV4cCI6MjA5MDM4NDc5Nn0.f35B2aiyHD00qJgfFCGaqLHWSe4jMY8Gw2QtiEVWHOc'; // Supabase → Settings → API → anon public
const ADMIN_PASSWORD = 'mirahuve2026';

/* ---- 결제 (PortOne V2) ----
   포트원 심사 통과 후, 콘솔에서 받은 값으로 채우고 PAYMENT_ENABLED 를 true 로 바꾸세요.
   그 전까지는 false 라서 결제 없이 기존처럼 예약만 접수됩니다(라이브 영향 없음). */
const PAYMENT_ENABLED = false;
const PORTONE_STORE_ID = 'store-여기에_상점식별코드';
const PORTONE_CHANNELS = {
  kakaopay: 'channel-key-여기에_카카오페이_채널키',
  naverpay: 'channel-key-여기에_네이버페이_채널키'
};
const SUBMIT_LABEL = PAYMENT_ENABLED ? '결제하고 예약 신청하기' : '예약 신청하기';

function genPaymentId(){ return 'mh_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

/* 결제창 호출 (성공 시 {paymentId} 반환, 실패/취소 시 throw) */
async function requestPortonePayment({ amount, orderName, method, customer }){
  const channelKey = PORTONE_CHANNELS[method];
  if(!window.PortOne) throw new Error('PORTONE_SDK_MISSING');
  if(!channelKey || channelKey.includes('여기에')) throw new Error('CHANNEL_NOT_SET');
  const paymentId = genPaymentId();
  const res = await window.PortOne.requestPayment({
    storeId: PORTONE_STORE_ID,
    channelKey,
    paymentId,
    orderName,
    totalAmount: amount,
    currency: 'KRW',
    payMethod: 'EASY_PAY',
    easyPay: { easyPayProvider: method==='kakaopay' ? 'KAKAOPAY' : 'NAVERPAY' },
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
  individual: { key:'individual', label:'개인 상담', dur:60,  price:150000, weekendOnly:true,
    slots:['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'] },
  youth:      { key:'youth',      label:'청소년·학부모 상담', dur:90, price:280000, weekendOnly:true,
    slots:['09:00','10:30','12:00','13:30','15:00','16:30','18:00'] },
  team:       { key:'team',       label:'팀 워크숍', dur:120, price:1000000, weekendOnly:false, noReportDiscount:true,
    slots:['09:00','11:00','13:00','15:00'] },
  couple:     { key:'couple',     label:'연인·부부 상담', dur:90, price:250000, weekendOnly:true,
    slots:['09:00','10:30','12:00','13:30','15:00','16:30','18:00'] }
};
const REPORT_DISCOUNT = 40; // 결과지 업로드 시 할인율(%)
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
    const { data, error } = await sbClient.from('bookings').insert([row]).select();
    if(error) throw error;
    return data[0];
  },
  async listBookings(){
    if(!CONFIGURED) return [];
    const { data, error } = await sbClient.from('bookings').select('*').order('created_at',{ascending:false});
    if(error) throw error;
    return data||[];
  },
  async bookingsOnDate(date){
    if(!CONFIGURED) return [];
    const { data } = await sbClient.from('bookings')
      .select('booking_time,duration_min,status').eq('booking_date',date).neq('status','cancelled');
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
  }
};

/* =========================================================
   네비게이션 / 스크롤 리빌
   ========================================================= */
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
  dateInput.min = todayStr();

  // 서비스 카드(상단) → 폼으로 스크롤 + 선택
  $$('.btn-card').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectService(btn.dataset.service);
      $('#booking').scrollIntoView({behavior:'smooth'});
    });
  });
  // 폼 안 서비스 선택
  $$('#servicePick .pick').forEach(btn=>{
    btn.addEventListener('click', ()=> selectService(btn.dataset.service));
  });

  dateInput.addEventListener('change', ()=>{ state.date = dateInput.value; state.time=null; renderSlots(); });

  // 결과지 보유 체크 → 업로드 필드 표시
  $('#bReport').addEventListener('change', e=>{
    $('#reportUploadWrap').hidden = !e.target.checked;
    if(!e.target.checked) $('#bReportFile').value = '';
    updatePricePreview();
  });
  $('#bReportFile').addEventListener('change', updatePricePreview);

  $('#bookingForm').addEventListener('submit', submitBooking);

  // 결제 활성화 시 결제수단 선택 노출 + 버튼 문구
  if(PAYMENT_ENABLED){
    const pw=$('#payMethodWrap'); if(pw) pw.hidden=false;
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
    ? '주말(토·일)만 예약 가능합니다.'
    : '평일·주말 모두 예약 가능합니다.';
  if(state.date) renderSlots();
  updatePricePreview();
}

async function renderSlots(){
  const grid = $('#slotGrid');
  const svc = state.service && SERVICES[state.service];
  if(!svc){ grid.innerHTML = '<span class="slot-empty">서비스를 먼저 선택해 주세요.</span>'; return; }
  if(!state.date){ grid.innerHTML = '<span class="slot-empty">날짜를 선택하면 가능한 시간이 표시됩니다.</span>'; return; }
  if(svc.weekendOnly && !isWeekend(state.date)){
    grid.innerHTML = '<span class="slot-empty">이 서비스는 주말(토·일)만 예약 가능합니다.</span>'; return;
  }

  grid.innerHTML = '<span class="slot-empty">확인 중…</span>';
  let bookings = [], blocks = [];
  try { bookings = await db.bookingsOnDate(state.date); blocks = await db.blocksOnDate(state.date); }
  catch(e){ /* 미연결 시 전부 가능으로 표시 */ }

  const fullDay = blocks.some(b=> !b.block_time);
  const now = new Date(); const isToday = state.date === todayStr();
  const nowMin = now.getHours()*60 + now.getMinutes();

  grid.innerHTML = '';
  svc.slots.forEach(slot=>{
    const s = toMin(slot), e = s + svc.dur;
    let taken = fullDay;
    if(!taken) taken = bookings.some(bk=> overlap(s, e, toMin(bk.booking_time), toMin(bk.booking_time)+(bk.duration_min||60)));
    if(!taken) taken = blocks.some(b=> b.block_time && toMin(b.block_time) >= s && toMin(b.block_time) < e);
    if(!taken && isToday && s <= nowMin) taken = true;

    const btn = document.createElement('button');
    btn.type='button'; btn.className = 'slot' + (taken?' taken':''); btn.textContent = slot;
    if(!taken){
      btn.addEventListener('click', ()=>{
        state.time = slot;
        $$('.slot',grid).forEach(x=> x.classList.remove('active'));
        btn.classList.add('active');
      });
    } else { btn.disabled = true; }
    grid.appendChild(btn);
  });
}

async function submitBooking(ev){
  ev.preventDefault();
  const msg = $('#formMsg'); msg.className='form-msg'; msg.textContent='';
  if(!state.service){ return fail(msg,'서비스를 선택해 주세요.'); }
  if(!state.date){ return fail(msg,'날짜를 선택해 주세요.'); }
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
    // 0) 결제 (활성화된 경우에만)
    if(PAYMENT_ENABLED){
      btn.textContent='결제 진행 중…';
      try{
        const method = $('#payMethod') ? $('#payMethod').value : 'kakaopay';
        const pay = await requestPortonePayment({
          amount: final, orderName: svc.label, method,
          customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email }
        });
        row.payment_id = pay.paymentId;
        row.pay_method = method;
        row.payment_status = 'paid'; // ⚠ 서버 검증 전 상태. 추후 Edge Function 검증 연동 필요.
      }catch(pe){
        btn.disabled=false; btn.textContent=SUBMIT_LABEL;
        if(pe.message==='CHANNEL_NOT_SET' || pe.message==='PORTONE_SDK_MISSING'){
          return fail(msg,'결제 설정이 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        }
        return fail(msg,'결제가 취소되었거나 완료되지 않았습니다. 다시 시도해 주세요.');
      }
    }
    // 1) 결과지 업로드 (결제 성공 후)
    if(wantReport && file){
      btn.textContent='결과지 업로드 중…';
      row.report_path = await db.uploadReport(file);
    }
    // 2) 예약 저장
    await db.createBooking(row);
    msg.className='form-msg ok';
    msg.textContent = PAYMENT_ENABLED
      ? `결제가 완료되어 예약이 접수되었습니다. 확정 안내 메일을 곧 보내드릴게요. 감사합니다.`
      : (rate > 0
        ? `예약이 접수되었습니다. 결과지 확인 후 40% 할인된 ${won(final)}으로 안내드릴게요. 감사합니다.`
        : '예약이 접수되었습니다. 확정 안내 메일을 곧 보내드릴게요. 감사합니다.');
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

/* =========================================================
   어드민
   ========================================================= */
let adminAuthed = false;
let currentFilter = 'all';

function initAdmin(){
  window.addEventListener('hashchange', handleHash);
  handleHash();
  $('#adminClose').addEventListener('click', ()=>{ location.hash=''; });
  $('#adminLoginBtn').addEventListener('click', adminLogin);
  $('#adminPw').addEventListener('keydown', e=>{ if(e.key==='Enter') adminLogin(); });

  $$('.atab').forEach(t=> t.addEventListener('click', ()=>{
    $$('.atab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
    const tab=t.dataset.tab;
    $('#panelBookings').hidden = tab!=='bookings';
    $('#panelBlocks').hidden = tab!=='blocks';
    if(tab==='blocks') loadBlocks();
  }));
  $$('#statusFilter .fbtn').forEach(b=> b.addEventListener('click', ()=>{
    $$('#statusFilter .fbtn').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    currentFilter=b.dataset.status; renderBookings();
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

function adminLogin(){
  const msg=$('#adminLoginMsg'); msg.className='form-msg';
  if($('#adminPw').value === ADMIN_PASSWORD){
    adminAuthed=true;
    $('#adminLogin').hidden=true; $('#adminDash').hidden=false;
    loadBookings();
  } else { msg.className='form-msg err'; msg.textContent='비밀번호가 올바르지 않습니다.'; }
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
    ? ` · <span style="color:#1a7a4a;font-weight:600;">결제완료${b.pay_method?'('+(b.pay_method==='kakaopay'?'카카오페이':b.pay_method==='naverpay'?'네이버페이':b.pay_method)+')':''}</span>`
    : '';
  if(b.discount_rate > 0){
    return `<div class="bk-price">💳 <strong>${won(b.final_price)}</strong> <span class="bk-strike">${won(b.base_price)}</span> · 결과지 40% 할인${b.report_path?' · 결과지 첨부됨':''}${paidTag}</div>`;
  }
  return `<div class="bk-price">💳 ${won(b.final_price!=null?b.final_price:b.base_price)}${paidTag}</div>`;
}

function flash(btn,t){ const o=btn.textContent; btn.textContent=t; setTimeout(()=>btn.textContent=o,1200); }

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
const BLOCK_TIMES = (()=>{ const a=[]; for(let h=9;h<=19;h++){ a.push(`${String(h).padStart(2,'0')}:00`); a.push(`${String(h).padStart(2,'0')}:30`); } return a; })();
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
  initNav();
  initBooking();
  initAdmin();
  // 이메일 mailto 조합 (평문 노출/난독화 방지)
  const em = document.getElementById('emailLink');
  if(em){ em.href = 'mailto:' + em.dataset.user + '@' + em.dataset.domain; }
});
