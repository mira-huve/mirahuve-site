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

create policy "anon insert bookings"
  on public.bookings for insert
  to anon
  with check (true);

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
  with check (true);

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
  with check (true);

create policy "admin full access pair_report_orders"
  on public.pair_report_orders for all
  to authenticated
  using (true) with check (true);

-- ============================================================
--  실행 후 할 일:
--  ① Authentication → Users → [Add user] →
--       Email: mira@mirahuve.com  /  비밀번호 설정  /  "Auto Confirm User" 체크
--  ② 사이트에서 푸터 '관리자' → 이메일·비밀번호로 로그인
-- ============================================================
