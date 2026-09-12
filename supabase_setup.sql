-- ============================================================
--  MIRA HUVE — Supabase 보안 설정
--  어드민 인증을 Supabase Auth로 옮기고, RLS로 고객 개인정보를 보호합니다.
--
--  실행 방법: Supabase 대시보드 → SQL Editor → New query →
--             아래 전체를 붙여넣고 [Run]. (여러 번 실행해도 안전합니다)
-- ============================================================

-- 0) 두 테이블에 RLS(행 수준 보안) 켜기
alter table public.bookings       enable row level security;
alter table public.blocked_slots  enable row level security;

-- 0-1) bookings — 최근 추가된 기능(결제·준비상태·메모)이 쓰는 컬럼을 안전하게 보강
--      (이미 있으면 무시됩니다. 이 컬럼이 없으면 결제 후 예약 INSERT가 실패합니다.)
alter table public.bookings add column if not exists payment_id text;
alter table public.bookings add column if not exists pay_method text;
alter table public.bookings add column if not exists payment_status text;
alter table public.bookings add column if not exists prep_done boolean not null default false;
alter table public.bookings add column if not exists cancel_reason text;
alter table public.bookings add column if not exists memo text;
alter table public.bookings add column if not exists updated_at timestamptz;
alter table public.bookings add column if not exists has_report boolean not null default false;
alter table public.bookings add column if not exists report_path text;
alter table public.bookings add column if not exists base_price int;
alter table public.bookings add column if not exists final_price int;
alter table public.bookings add column if not exists discount_rate int;

-- 1) bookings 정책 -------------------------------------------
--    · 익명(anon)      : INSERT만 허용 (예약 신청). 읽기/수정/삭제 불가 → 고객정보 보호
--    · 관리자(authenticated) : 전체 허용
drop policy if exists "anon insert bookings"          on public.bookings;
drop policy if exists "admin full access bookings"    on public.bookings;

-- 결제 위조 방지: anon은 payment_status='paid' 행을 직접 만들 수 없다.
-- '결제완료' 접수는 verify-payment Edge Function(service role)만 저장한다.
create policy "anon insert bookings"
  on public.bookings for insert
  to anon
  with check (payment_status is distinct from 'paid');

create policy "admin full access bookings"
  on public.bookings for all
  to authenticated
  using (true) with check (true);

-- 2) blocked_slots 정책 --------------------------------------
--    · 익명   : SELECT만 (차단된 시간 표시용 — 개인정보 아님)
--    · 관리자 : 전체
drop policy if exists "anon read blocks"          on public.blocked_slots;
drop policy if exists "admin full access blocks"  on public.blocked_slots;

create policy "anon read blocks"
  on public.blocked_slots for select
  to anon
  using (true);

create policy "admin full access blocks"
  on public.blocked_slots for all
  to authenticated
  using (true) with check (true);

-- 3) 예약 가용성 함수 ----------------------------------------
--    익명 사용자는 이 함수로 '해당 날짜에 이미 예약된 시간대'만 조회합니다.
--    고객 이름·연락처·이메일은 절대 반환하지 않습니다.
create or replace function public.slots_on_date(d text)
returns table (booking_time text, duration_min int, status text)
language sql
security definer
set search_path = public
as $$
  select booking_time::text, duration_min::int, status::text
  from public.bookings
  where booking_date::text = d
    and status <> 'cancelled';
$$;

revoke all on function public.slots_on_date(text) from public;
grant execute on function public.slots_on_date(text) to anon, authenticated;

-- 4) Storage: 결과지 버킷(reports) 정책 ----------------------
--    · 익명   : 업로드(INSERT)만
--    · 관리자 : 다운로드·서명URL(SELECT)
--    (reports 버킷이 아직 없으면 대시보드 → Storage 에서 먼저 만드세요)
drop policy if exists "anon upload reports"     on storage.objects;
drop policy if exists "admin read reports"      on storage.objects;

create policy "anon upload reports"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'reports');

-- 관리자(authenticated)로 로그인된 브라우저에서 신청 폼을 테스트할 때도 업로드가 가능하도록 허용
drop policy if exists "admin upload reports" on storage.objects;
create policy "admin upload reports"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'reports');

create policy "admin read reports"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'reports');

-- ============================================================
--  5) 강점 리포트 신청(report_orders) 테이블 + 정책
--     기본 리포트(총평+커리어+관계+팀·리더십+의사결정) 패키지 + 페르소나 추가 옵션 결제 신청.
-- ============================================================
create table if not exists public.report_orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_phone text not null,
  customer_email text not null,
  personas jsonb not null default '[]'::jsonb,   -- 선택한 추가 옵션(라벨 또는 직접입력 텍스트) 배열
  persona_count int not null default 0,
  base_price int not null,
  addon_price int not null default 0,
  total_price int not null,
  payment_id text,
  pay_method text,
  payment_status text,
  status text not null default 'pending',        -- pending·confirmed·completed·cancelled
  prep_done boolean not null default false,       -- 테스트 완료 여부(어드민 체크)
  has_report boolean not null default false,      -- 기존 강점(34개) 결과지를 업로드해 테스트코드·완료 단계를 생략한 경우
  report_path text,                               -- has_report=true일 때 업로드된 결과지의 Storage 경로
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- 이미 만들어진 테이블에 새 컬럼을 안전하게 추가(이미 있으면 무시)
alter table public.report_orders add column if not exists has_report boolean not null default false;
alter table public.report_orders add column if not exists report_path text;

alter table public.report_orders enable row level security;

drop policy if exists "anon insert report_orders"       on public.report_orders;
drop policy if exists "admin full access report_orders"  on public.report_orders;

create policy "anon insert report_orders"
  on public.report_orders for insert
  to anon
  with check (payment_status is distinct from 'paid');

create policy "admin full access report_orders"
  on public.report_orders for all
  to authenticated
  using (true) with check (true);

-- ============================================================
--  6) 관계 리포트 신청(pair_report_orders) 테이블 + 정책
--     두 사람의 강점 데이터를 함께 해석하는 리포트. 관계 유형(대칭/비대칭)과
--     역할 배정, 두 사람 각각의 결과지 유무를 저장한다.
-- ============================================================
create table if not exists public.pair_report_orders (
  id uuid primary key default gen_random_uuid(),
  relationship_key text not null,        -- lover·couple·friend·family·sibling·org_peer·org_lead·org_ceo
  relationship_label text not null,      -- 사람이 읽는 관계·역할 설명 (예: "가족 (사람1=부모 · 사람2=자식)")
  person1_name text not null,
  person1_phone text not null,
  person1_email text not null,
  person1_role text,                     -- 비대칭 관계일 때만 (예: '부모')
  person1_has_report boolean not null default false,
  person1_report_path text,
  person2_name text not null,
  person2_phone text not null,
  person2_email text not null,
  person2_role text,
  person2_has_report boolean not null default false,
  person2_report_path text,
  base_price int not null,
  total_price int not null,
  payment_id text,
  pay_method text,
  payment_status text,
  status text not null default 'pending', -- pending·confirmed·completed·cancelled
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

alter table public.pair_report_orders enable row level security;

drop policy if exists "anon insert pair_report_orders"      on public.pair_report_orders;
drop policy if exists "admin full access pair_report_orders" on public.pair_report_orders;

create policy "anon insert pair_report_orders"
  on public.pair_report_orders for insert
  to anon
  with check (payment_status is distinct from 'paid');

create policy "admin full access pair_report_orders"
  on public.pair_report_orders for all
  to authenticated
  using (true) with check (true);

-- ============================================================
--  7) 강점 상담소 사연 접수(story_submissions) 테이블 + 정책
--     유튜브 코너 "강점 상담소"에 시청자가 고민 사연을 보내는 폼.
--     사연 본문은 민감정보에 가까우므로 anon은 INSERT만 하고 읽지 못한다.
--
--     접수 경로 3가지 (entry_type)
--       has_report : 결과지를 이미 갖고 있어 바로 업로드 — 결제 없음
--       paid       : 결과지가 없어 진단 코드를 구매(50,000원) — verify-payment 가 저장
--       free_draw  : 결과지 없이 사연만 — 매달 2명 무료 코드 추첨 대상
--
--     결과지 확보 단계(report_stage)와 제작 단계(status)를 분리해 둔다.
--       report_stage : none → paid → code_sent → ready(결과지 도착)
--       status       : received → shortlisted → selected → aired / declined
-- ============================================================
create table if not exists public.story_submissions (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,                  -- 영상에서 불릴 공개용 호칭(실명 금지 안내)
  contact_email text not null,             -- 선정 안내·코드·업로드 링크 발송용
  applicant_name text,                     -- 결제한 경우에만 — 결제·환불 확인용
  applicant_phone text,                    -- 결제한 경우에만
  concern_type text,                       -- (미사용) 초기 설계의 고민 분류 — 폼에서 제거했다
  story text not null,                     -- 고민 내용(자유서술) — 각색 전 원문
  question text not null,                  -- 가장 듣고 싶은 질문 한 줄(영상의 처음과 끝이 이 문장을 쓴다)
  age_band text,                           -- 연령대 범주(해석 맥락용)
  job_band text,                           -- 하는 일 범주(해석 맥락용)

  entry_type text not null default 'free_draw',   -- has_report | paid | free_draw
  report_stage text not null default 'none',      -- none | paid | code_sent | ready
  has_report boolean not null default false,
  report_path text,                        -- Storage 'reports' 버킷 내 경로
  -- 결과지 재업로드용 개인 링크 토큰. 코드 발송 메일에 담아 보낸다.
  -- story-upload.html?t=<upload_token> 로 들어와 attach_story_report() 를 호출한다.
  upload_token uuid not null default gen_random_uuid(),
  code_sent_at timestamptz,                -- 진단 코드를 보낸 시점
  report_uploaded_at timestamptz,          -- 결과지가 도착한 시점
  draw_won_at timestamptz,                 -- 무료 추첨에 당첨된 시점

  price int,                               -- 결제한 경우 결제 금액
  payment_id text,
  pay_method text,
  payment_status text,

  consent_broadcast boolean not null default false,  -- [필수] 각색·익명 소개 동의
  consent_privacy   boolean not null default false,  -- [필수] 개인정보 수집·이용 동의
  consent_research  boolean not null default false,  -- [선택] 연구 데이터 익명 축적 동의(위키 인제스트 가부)

  status text not null default 'received', -- received·shortlisted·selected·aired·declined
  episode_no text,                         -- 채택 시 SC 번호
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- 이미 만들어진 테이블에도 안전하게 컬럼을 더한다(이미 있으면 무시)
alter table public.story_submissions add column if not exists applicant_name text;
alter table public.story_submissions add column if not exists applicant_phone text;
alter table public.story_submissions add column if not exists entry_type text not null default 'free_draw';
alter table public.story_submissions add column if not exists report_stage text not null default 'none';
alter table public.story_submissions add column if not exists upload_token uuid not null default gen_random_uuid();
alter table public.story_submissions add column if not exists code_sent_at timestamptz;
alter table public.story_submissions add column if not exists report_uploaded_at timestamptz;
alter table public.story_submissions add column if not exists draw_won_at timestamptz;
alter table public.story_submissions add column if not exists price int;
alter table public.story_submissions add column if not exists payment_id text;
alter table public.story_submissions add column if not exists pay_method text;
alter table public.story_submissions add column if not exists payment_status text;

create index if not exists idx_story_status  on public.story_submissions (status);
create index if not exists idx_story_stage   on public.story_submissions (report_stage);
create index if not exists idx_story_created on public.story_submissions (created_at desc);
create unique index if not exists idx_story_token on public.story_submissions (upload_token);

alter table public.story_submissions enable row level security;

drop policy if exists "anon insert story_submissions"       on public.story_submissions;
drop policy if exists "admin full access story_submissions" on public.story_submissions;

-- 익명 접수에 걸 수 있는 제약을 DB에서도 건다 — 폼 검증이 우회되어도 저장되지 않는다.
--  · 필수 동의 둘이 없으면 거부
--  · 상태는 'received' 고정 — 접수자가 스스로 '채택'을 넣을 수 없다
--  · 결제 경로(entry_type='paid', payment_status='paid')는 verify-payment(service role)만 만든다
create policy "anon insert story_submissions"
  on public.story_submissions for insert
  to anon
  with check (
    consent_broadcast = true
    and consent_privacy = true
    and status = 'received'
    and entry_type in ('has_report', 'free_draw')
    and payment_status is distinct from 'paid'
  );

create policy "admin full access story_submissions"
  on public.story_submissions for all
  to authenticated
  using (true) with check (true);

-- ---- 결과지 재업로드 (코드로 진단을 마친 뒤 돌아와 파일만 올리는 경로) ----
-- anon 은 story_submissions 를 읽지도 수정하지도 못하므로, 토큰으로만 동작하는
-- security definer 함수 두 개를 통해서만 이 작업을 허용한다.

-- 업로드 화면에 보여줄 최소 정보(호칭·단계)만 돌려준다. 사연 본문·이메일은 반환하지 않는다.
create or replace function public.story_by_token(p_token uuid)
returns table (nickname text, report_stage text)
language sql
security definer
set search_path = public
as $$
  select nickname, report_stage
  from public.story_submissions
  where upload_token = p_token
$$;

-- 토큰이 가리키는 사연에 결과지 경로를 붙이고 '결과지 도착'으로 올린다.
-- 잘못 올린 경우 다시 올릴 수 있도록 덮어쓰기를 허용한다.
create or replace function public.attach_story_report(p_token uuid, p_path text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if p_path is null or length(p_path) = 0 or length(p_path) > 500 then
    return false;
  end if;
  update public.story_submissions
     set report_path        = p_path,
         has_report         = true,
         report_stage       = 'ready',
         report_uploaded_at = now(),
         updated_at         = now()
   where upload_token = p_token;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.story_by_token(uuid)              from public;
revoke all on function public.attach_story_report(uuid, text)   from public;
grant execute on function public.story_by_token(uuid)            to anon, authenticated;
grant execute on function public.attach_story_report(uuid, text) to anon, authenticated;

-- ============================================================
--  실행 후 할 일:
--  ① Authentication → Users → [Add user] →
--       Email: mira@mirahuve.com  /  비밀번호 설정  /  "Auto Confirm User" 체크
--  ② 사이트에서 푸터 '관리자' → 이메일·비밀번호로 로그인
-- ============================================================
