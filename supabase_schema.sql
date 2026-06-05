-- ============================================================
-- MIRA HUVE · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN
-- ============================================================

-- 예약 본체 ---------------------------------------------------
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz default now(),
  updated_at    timestamptz,
  service_key   text not null,        -- individual | youth | team
  service_label text not null,        -- 화면 표시용 이름
  duration_min  int  not null,        -- 60 / 90 / 120
  booking_date  date not null,
  booking_time  text not null,        -- '09:00' 형식
  customer_name  text not null,
  customer_phone text not null,
  customer_email text not null,
  purpose        text,                -- 상담 목적(선택형)
  purpose_detail text,                -- 자유 기입
  has_report     boolean default false,-- 강점 리포트 업로드 여부
  report_path    text,                 -- Storage 'reports' 버킷 내 파일 경로
  base_price     int,                  -- 정가(원)
  final_price    int,                  -- 할인 적용 후 결제 금액(원)
  discount_rate  int default 0,        -- 할인율(%) — 결과지 업로드 시 40
  status         text default 'pending', -- pending|confirmed|completed|cancelled
  prep_done      boolean default false,  -- 코드포함(테스트) 완료 확인 여부
  cancel_reason  text,                   -- 자동/수동 취소 사유
  payment_id     text,                   -- 결제 식별자(PortOne paymentId)
  payment_status text default 'unpaid',  -- unpaid | paid
  pay_method     text,                   -- kakaopay | naverpay
  memo           text                 -- 관리자 메모
);
create index if not exists idx_bookings_date  on bookings (booking_date);
create index if not exists idx_bookings_email on bookings (customer_email);

-- 기존 테이블에 이미 만들어져 있다면 아래로 컬럼만 추가됩니다(안전).
alter table bookings add column if not exists report_path   text;
alter table bookings add column if not exists base_price    int;
alter table bookings add column if not exists final_price    int;
alter table bookings add column if not exists discount_rate  int default 0;
alter table bookings add column if not exists prep_done      boolean default false;
alter table bookings add column if not exists cancel_reason  text;
alter table bookings add column if not exists payment_id     text;
alter table bookings add column if not exists payment_status text default 'unpaid';
alter table bookings add column if not exists pay_method     text;

-- 차단 슬롯 ---------------------------------------------------
create table if not exists blocked_slots (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  block_date date not null,
  block_time text,    -- 비우면(null) 그 날짜 종일 차단
  reason     text
);
create index if not exists idx_blocks_date on blocked_slots (block_date);

-- 접근 정책(RLS) ---------------------------------------------
-- 현재는 anon 키만으로 동작하는 단순 구조입니다.
-- 추후 고객 개인정보 보호를 강화하려면 조회용 view 또는
-- Edge Function 으로 옮기는 방식을 권장합니다.
alter table bookings      enable row level security;
alter table blocked_slots enable row level security;

drop policy if exists "anon_all_bookings" on bookings;
drop policy if exists "anon_all_blocks"   on blocked_slots;

create policy "anon_all_bookings" on bookings
  for all using (true) with check (true);
create policy "anon_all_blocks" on blocked_slots
  for all using (true) with check (true);

-- 결과지 업로드 Storage ---------------------------------------
-- 비공개 버킷 'reports' 생성(공개 OFF). 관리자만 서명 URL로 열람.
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

drop policy if exists "reports_anon_upload" on storage.objects;
drop policy if exists "reports_anon_read"   on storage.objects;

-- 예약자가 결과지를 올릴 수 있도록 업로드 허용
create policy "reports_anon_upload" on storage.objects
  for insert to anon with check (bucket_id = 'reports');
-- 관리자 화면에서 서명 URL 생성을 위해 읽기 허용
create policy "reports_anon_read" on storage.objects
  for select to anon using (bucket_id = 'reports');
