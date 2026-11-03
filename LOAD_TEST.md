# Load Testing — Reliable Order API

Pengujian beban dilakukan menggunakan [k6](https://k6.io/) dari Grafana untuk mengukur throughput, latency, error rate, dan perilaku concurrency API saat menerima banyak request secara bersamaan.

## Struktur

```
load-tests/
├── order-load.js      # Skenario pengujian beban pembuatan order
└── results.json       # Hasil eksekusi nyata (hasil k6 run --out json)
```

## Persiapan

### 1. Database khusus load testing

Jangan gunakan database development atau integration test. Buat database terpisah:

```sql
CREATE DATABASE reliable_order_load
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

GRANT SELECT, INSERT, UPDATE, DELETE
ON reliable_order_load.*
TO 'order_api_user'@'localhost';
```

Jalankan `src/database/schema.sql` pada database `reliable_order_load`, lalu masukkan produk pengujian:

```sql
INSERT INTO products (id, name, price, stock)
VALUES (1, 'Load Test Keyboard', 350000, 100000);
```

### 2. Install k6 (Windows)

```powershell
winget install k6 --source winget
k6 version
```

### 3. Jalankan API dengan database load test

```powershell
cd D:\framework\express\reliable-order-api
$env:DB_NAME = "reliable_order_load"
pnpm run dev
```

Verifikasi di terminal lain:

```powershell
Invoke-RestMethod http://localhost:3000/health/db
```

Harus mengembalikan `database: "connected"`.

## Menjalankan Load Test

### Baseline — 10 VUs, 30 detik

```powershell
$env:BASE_URL = "http://localhost:3000"
pnpm load:test
```

### Simpan hasil ke JSON (portofolio)

```powershell
pnpm load:test:json
```

### Reset database sebelum skenario berikutnya

```sql
DELETE FROM idempotency_keys;
DELETE FROM orders;

UPDATE products
SET stock = 100000
WHERE id = 1;
```

## Skenario Beban Tingkat Lanjut

Ubah nilai `vus` di `load-tests/order-load.js`, lalu reset database dan jalankan ulang:

| Skenario | Virtual users | Durasi   |
| -------- | ------------- | -------- |
| Baseline | 10            | 30 detik |
| Medium   | 25            | 30 detik |
| High     | 50            | 30 detik |
| Stress   | 100           | 30 detik |

Jalankan satu skenario pada satu waktu terhadap database yang sama agar hasil mudah dibandingkan.

## Metrik yang Diukur

| Metrik | Fungsi |
|--------|--------|
| Throughput | Jumlah request yang diproses per detik (`http_reqs`) |
| Latency | Waktu respons (`http_req_duration`, terutama p(95)) |
| Error rate | Persentase request gagal (`http_req_failed`) |
| Concurrency | Perilaku API ketika banyak request bersamaan (`vus`) |

Threshold default:

- `http_req_failed < 1%`
- `http_req_duration p(95) < 1000ms`
- `checks > 99%`

## Verifikasi Konsistensi Database

Setelah pengujian selesai, pastikan stok tidak negatif dan tidak ada duplicate order:

```sql
SELECT stock FROM products WHERE id = 1;

SELECT COUNT(*) AS total_orders FROM orders;

SELECT COUNT(*) AS total_idempotency_keys FROM idempotency_keys;
```

Untuk skenario seluruh request berhasil, jumlah order seharusnya sama dengan jumlah idempotency key, dan stok berkurang sesuai jumlah order.

## Catatan

Hasil angka di dokumentasi ini hanya contoh format, bukan hasil aktual API. Hasil pengujian nyata harus berasal dari eksekusi `k6 run` terhadap API yang berjalan.
