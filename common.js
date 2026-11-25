/* =========================================================
   ① Firebaseの設定（Firebaseコンソールからコピーして貼る）
   空のままだと「デモモード」（この端末の中だけに保存）で動きます
   ========================================================= */
export const firebaseConfig = {
  apiKey: "AIzaSyBZ80dULSKmok1nEFpd_fncfzf4GYj7XaA",
  authDomain: "syashin-hozon.firebaseapp.com",
  projectId: "syashin-hozon",
  storageBucket: "syashin-hozon.firebasestorage.app",
  messagingSenderId: "556591750255",
  appId: "1:556591750255:web:3a192684a6d75ba352c19a"
};

/* ② 先生ログイン用のメールアドレス
   Firebase の Authentication で作ったユーザーと同じにする。
   firestore.rules の中にも同じものを書く。 */
export const TEACHER_EMAIL = "sensei@example.com";

/* ③ クラスと人数（クラス名は「6-1」のような 数字-数字 の形にする） */
export const CLASSES = [
  { id: "6-1", count: 23 },
  { id: "6-2", count: 23 },
];

/* ④ 1人あたりの写真の枚数・印刷の1ページあたりの人数 */
export const PHOTO_COUNT = 3;
export const PER_PAGE = 2;

/* ========================================================= */

export const configured = !!(firebaseConfig.apiKey && firebaseConfig.projectId);
export const photoId = (cls, no, idx) => `${cls}_${no}_${idx}`;
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const MAX_NO = 40; // 全削除のときに消す番号の上限（ルールの上限と同じ）

/* ---------- 写真を小さくする（長辺1200px・600KB以下のJPEG） ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}
function toBlob(canvas, q) {
  return new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", q));
}
export async function compressImage(file, maxSide = 1200, maxBytes = 600 * 1024) {
  const img = await loadImage(file);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) throw new Error("decode");
  for (const side of [maxSide, 1000, 800]) {
    const s = Math.min(1, side / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.82, 0.72, 0.62, 0.52]) {
      const blob = await toBlob(c, q);
      if (blob.size <= maxBytes) { c.width = c.height = 0; return { blob, w, h }; }
    }
    c.width = c.height = 0; // iPadのメモリをすぐ返す
  }
  throw new Error("toobig");
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}
// cls を渡すとそのクラスだけ、渡さないと全クラスの写真ID
function photoIds(cls) {
  const ids = [];
  for (const c of CLASSES.filter(c => !cls || c.id === cls))
    for (let no = 1; no <= MAX_NO; no++)
      for (let i = 1; i <= PHOTO_COUNT; i++) ids.push(photoId(c.id, no, i));
  return ids;
}

/* ---------- Firebase ---------- */
let fbp = null;
function fb() {
  if (!fbp) fbp = (async () => {
    const { initializeApp } = await import(SDK + "firebase-app.js");
    const fs = await import(SDK + "firebase-firestore.js");
    const app = initializeApp(firebaseConfig);
    return { app, fs, db: fs.getFirestore(app) };
  })();
  return fbp;
}
let authp = null;
function fbAuth() {
  if (!authp) authp = (async () => {
    const { app } = await fb();
    const a = await import(SDK + "firebase-auth.js");
    return { a, auth: a.getAuth(app) };
  })();
  return authp;
}

// photos は 1〜PHOTO_COUNT 枚。使わない枠は「空の写真」（data 0バイト・w=h=0）で上書きして、
// 前に送った写真が残らないようにする（児童は削除できないルールなので）
const firebaseBackend = {
  async submit(cls, no, photos) {
    const { fs, db } = await fb();
    const batch = fs.writeBatch(db);
    for (let i = 0; i < PHOTO_COUNT; i++) {
      const p = photos[i];
      const data = fs.Bytes.fromUint8Array(p ? new Uint8Array(await p.blob.arrayBuffer()) : new Uint8Array(0));
      batch.set(fs.doc(db, "photos", photoId(cls, no, i + 1)), {
        cls, no, idx: i + 1, data, w: p ? p.w : 0, h: p ? p.h : 0, updatedAt: fs.serverTimestamp()
      });
    }
    await withTimeout(batch.commit(), 90000);
  },
  async loadClass(cls) {
    const { fs, db } = await fb();
    const snap = await fs.getDocs(fs.query(fs.collection(db, "photos"), fs.where("cls", "==", cls)));
    return snap.docs.filter(d => d.data().w > 0).map(d => {
      const v = d.data();
      return {
        no: v.no, idx: v.idx, w: v.w, h: v.h,
        blob: new Blob([v.data.toUint8Array()], { type: "image/jpeg" }),
        updatedAt: v.updatedAt ? v.updatedAt.toMillis() : 0
      };
    });
  },
  async deletePhotos(cls) {
    const { fs, db } = await fb();
    const ids = photoIds(cls);
    for (let s = 0; s < ids.length; s += 450) {
      const batch = fs.writeBatch(db);
      ids.slice(s, s + 450).forEach(id => batch.delete(fs.doc(db, "photos", id)));
      await batch.commit();
    }
  },
  onAuth(cb) {
    fbAuth().then(({ a, auth }) =>
      a.onAuthStateChanged(auth, u => cb(!!u && (u.email || "") === TEACHER_EMAIL.toLowerCase())));
  },
  async login(pw) {
    const { a, auth } = await fbAuth();
    await a.signInWithEmailAndPassword(auth, TEACHER_EMAIL, pw);
  },
  async logout() {
    const { a, auth } = await fbAuth();
    await a.signOut(auth);
  }
};

/* ---------- デモ（この端末のIndexedDBに保存） ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("shashin-teishutsu-demo", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("photos");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(mode, fn) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("photos", mode);
    const r = fn(t.objectStore("photos"));
    t.oncomplete = () => res(r && "result" in r ? r.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
async function sampleBlob(w, h, hue, title, sub) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${hue},55%,78%)`);
  g.addColorStop(1, `hsl(${(hue + 40) % 360},45%,92%)`);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = `hsl(${(hue + 180) % 360},35%,55%)`;
  x.beginPath(); x.arc(w * 0.75, h * 0.3, Math.min(w, h) * 0.14, 0, Math.PI * 2); x.fill();
  x.fillStyle = `hsl(${hue},30%,45%)`;
  x.beginPath(); x.moveTo(0, h); x.lineTo(w * 0.35, h * 0.55); x.lineTo(w * 0.6, h * 0.78); x.lineTo(w * 0.8, h * 0.6); x.lineTo(w, h * 0.8); x.lineTo(w, h); x.fill();
  x.fillStyle = "rgba(0,0,0,.75)";
  x.font = `bold ${Math.round(Math.min(w, h) * 0.1)}px sans-serif`;
  x.fillText(title, w * 0.07, h * 0.18);
  x.font = `${Math.round(Math.min(w, h) * 0.07)}px sans-serif`;
  x.fillText(sub, w * 0.07, h * 0.3);
  const b = await toBlob(c, 0.8);
  c.width = c.height = 0;
  return b;
}
const DEMO_LOGIN = "shashin-teishutsu-demo-login";
const authCbs = [];
const demoLoggedIn = () => { try { return sessionStorage.getItem(DEMO_LOGIN) === "1"; } catch (e) { return false; } };
const setDemoLogin = v => {
  try { v ? sessionStorage.setItem(DEMO_LOGIN, "1") : sessionStorage.removeItem(DEMO_LOGIN); } catch (e) {}
  authCbs.forEach(cb => cb(v));
};

const demoBackend = {
  async submit(cls, no, photos) {
    await new Promise(r => setTimeout(r, 600));
    const now = Date.now();
    await idb("readwrite", st => {
      for (let i = 0; i < PHOTO_COUNT; i++) {
        const p = photos[i];
        st.put({ cls, no, idx: i + 1, w: p ? p.w : 0, h: p ? p.h : 0, blob: p ? p.blob : null, updatedAt: now }, photoId(cls, no, i + 1));
      }
    });
  },
  async loadClass(cls) {
    const all = await idb("readonly", st => st.getAll());
    return (all || []).filter(v => v.cls === cls && v.w > 0);
  },
  async deletePhotos(cls) {
    await idb("readwrite", st => { if (cls) photoIds(cls).forEach(id => st.delete(id)); else st.clear(); });
  },
  // お試し用：クラスごとに何人か抜けた状態のサンプル写真を入れる
  async fillSample() {
    const skip = { 0: [4, 11, 17, 20], 1: [2, 8] };
    const now = Date.now();
    const rows = [];
    for (const [ci, c] of CLASSES.entries()) {
      for (let no = 1; no <= c.count; no++) {
        if ((skip[ci] || []).includes(no)) continue;
        for (let i = 1; i <= PHOTO_COUNT; i++) {
          const portrait = i === 2 && no % 3 === 0; // ときどき縦長の写真もまぜる
          const w = portrait ? 900 : 1200, h = portrait ? 1200 : 900;
          rows.push({ id: photoId(c.id, no, i), v: { cls: c.id, no, idx: i, w, h, updatedAt: now - no * 60000,
            blob: await sampleBlob(w, h, (no * 37 + i * 90) % 360, `${c.id}  ${no}番`, `${i}まいめ`) } });
        }
      }
    }
    await idb("readwrite", st => { rows.forEach(r => st.put(r.v, r.id)); });
  },
  onAuth(cb) { authCbs.push(cb); setTimeout(() => cb(demoLoggedIn()), 0); },
  async login() { setDemoLogin(true); },
  async logout() { setDemoLogin(false); }
};

export const backend = configured ? firebaseBackend : demoBackend;
