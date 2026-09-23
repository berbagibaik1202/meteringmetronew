# iMacros Puppeteer Runner

Proyek ini adalah starter untuk menjalankan langkah-langkah iMacros dengan Node.js + Puppeteer.

## Yang sudah didukung

- `URL GOTO=...`
- `TAG ... ATTR=ID:... CONTENT=...`
- `TAG ... ATTR=NAME:... CONTENT=...`
- `TAG ... ATTR=TXT:...`
- klik elemen berdasarkan urutan `POS=n`
- decoding teks iMacros seperti `<SP>`

## Cara pakai

```bash
npm install
node index.js --headed
```

Untuk identifikasi selector, pakai:

```bash
node index.js IMACROSTXDIGITAL.txt --inspect
```

Untuk menjalankan variasi tertentu:

```bash
node index.js --variant=2
```

## Catatan penting

- File macro Anda saat ini berisi kredensial. Sebaiknya pindahkan ke environment variable atau file `.env`, lalu pakai placeholder seperti `{{LOGIN_USERNAME}}` dan `{{LOGIN_PASSWORD}}` di `CONTENT=...`.
- Nilai checklist dan file upload sekarang diambil dari `variations.json`.
- Variasi 1 memakai file gambar dari folder `img`.
- Variasi 2 diarahkan ke folder `img/variant2`; isi folder itu dengan gambar versi kedua sebelum menjalankannya.
- Variasi 3 dan 4 diarahkan ke folder `img/variant3` dan `img/variant4`.
- Selektor di macro iMacros sering sangat spesifik ke DOM tertentu. Kalau ada langkah yang gagal, biasanya perlu disesuaikan di `src/runner.js`.
- Beberapa aksi yang memakai `PATH` atau `RECT` kemungkinan perlu penyetelan manual karena itu sering berarti ikon SVG atau elemen visual yang tidak stabil.
- Mode `--inspect` membuka browser visible dan memberi jeda lebih lama antar langkah supaya Anda mudah mengecek elemen yang sedang dituju.

## Saran next step

Kalau Anda mau, saya bisa lanjutkan dengan:

1. membuat parser yang lebih lengkap untuk semua perintah iMacros yang Anda pakai;
2. menambahkan mode config supaya username/password dan nilai input tidak hardcoded;
3. membuat UI sederhana agar macro bisa dipilih dan dijalankan dari browser/desktop.
