// /organizer/js/events.js
import {
  db,
  collection,
  doc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  increment,
} from "../../firebase/firebase.js";

/* ============== DOM ============== */
const $btnNew       = document.querySelector('.toolbar a[href="#new-event"]');
const $openTbody    = document.getElementById("open-tbody");
const $closedTbody  = document.getElementById("closed-tbody");
const $openMore     = document.getElementById("open-more");
const $closedMore   = document.getElementById("closed-more");

const $modal        = document.getElementById("event-modal");
const $modalTitle   = $modal?.querySelector("#event-modal-title");
const $btnSave      = $modal?.querySelector('[data-action="save-event"]');
const $btnCancel    = $modal?.querySelector('[data-action="cancel-event"]');
const $eventDate    = $modal?.querySelector("#event-date");
const $deadlineDate = $modal?.querySelector("#deadline-date");
const $deadlineTime = $modal?.querySelector("#deadline-time");

const $tabBtns      = $modal?.querySelectorAll(".tab-btn");
const $tabDetails   = $modal?.querySelector("#tab-details");
const $tabProducts  = $modal?.querySelector("#tab-products");

/* Produkte-Tab – Add & Assigned */
const $addSearch    = document.getElementById("add-search");
const $addOnlyStd   = document.getElementById("add-only-standard");
const $addResultsTb = document.getElementById("add-results-tbody");

const $assignedTb   = document.getElementById("assigned-tbody");
const $assignedCount= document.getElementById("assigned-count");

/* ============== Status / State ============== */
// Flow inkl. rechnung_offen:
// offen → bestellbar → geschlossen → rechnung_offen → zahlung_offen → abgerechnet
const STATUS_FLOW   = ["offen","bestellbar","geschlossen","rechnung_offen","zahlung_offen","abgerechnet"];
const OPEN_SET      = new Set(["offen","bestellbar","geschlossen","rechnung_offen"]);
const CLOSED_SET    = new Set(["zahlung_offen","abgerechnet"]);

// Produkte sind NUR im Status 'offen' bearbeitbar
const EDITABLE_SET  = new Set(["offen"]);

const PAGE_SIZE     = 5;

let productsUIBound = false;

let editId = null;
let editStatus = "offen";

let openPage   = { items: [], lastDoc: null, exhausted: false, loading: false };
let closedPage = { items: [], lastDoc: null, exhausted: false, loading: false };

let allProducts = [];            // [{id,name,categoryId,isStandard,...}]
let categories  = new Map();     // categoryId -> categoryName

// Zuordnungen
let assigned = new Set();        // Edit-Modus: echte Firestore-Subdocs
let draftAssigned = null;        // Create-Modus: lokaler Entwurf (Set<productId>)

/* ============== Utils ============== */
const isTimestamp = (v) => v && (typeof v.toDate === "function" || typeof v.toMillis === "function");
const toDate = (v) => {
  if (!v) return null;
  if (isTimestamp(v)) return v.toDate ? v.toDate() : new Date(v.toMillis());
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
const fmtDate = (d) => d ? d.toLocaleDateString("de-DE") : "—";
const fmtDateTime = (d) =>
  d ? d.toLocaleString("de-DE", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—";

function composeLocalDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y,m,d] = dateStr.split("-").map(Number);
  const [hh,mm] = timeStr.split(":").map(Number);
  return new Date(y, (m-1), d, hh, mm, 0, 0);
}
function syncDeadlineDefaults() {
  const ev = $eventDate?.value;
  if (!ev) return;
  if (!$deadlineDate.value) $deadlineDate.value = ev;
  if (!$deadlineTime.value) $deadlineTime.value = "10:00";
}
const categoryName = (id) => categories.get(id) || id || "—";

/* ============== Data: Events (Paging) ============== */
async function fetchOpenPage() {
  if (openPage.loading || openPage.exhausted) return;
  openPage.loading = true;

  let qRef = query(
    collection(db,"events"),
    where("status","in", Array.from(OPEN_SET)),
    orderBy("eventAt","desc"),
    limit(PAGE_SIZE)
  );
  if (openPage.lastDoc) qRef = query(qRef, startAfter(openPage.lastDoc));

  const snap = await getDocs(qRef);
  if (snap.empty) openPage.exhausted = true;
  else {
    openPage.items.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })));
    openPage.lastDoc = snap.docs[snap.docs.length - 1];
  }
  openPage.loading = false;
}
async function fetchClosedPage() {
  if (closedPage.loading || closedPage.exhausted) return;
  closedPage.loading = true;

  let qRef = query(
    collection(db,"events"),
    where("status","in", Array.from(CLOSED_SET)),
    orderBy("eventAt","desc"),
    limit(PAGE_SIZE)
  );
  if (closedPage.lastDoc) qRef = query(qRef, startAfter(closedPage.lastDoc));

  const snap = await getDocs(qRef);
  if (snap.empty) closedPage.exhausted = true;
  else {
    closedPage.items.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })));
    closedPage.lastDoc = snap.docs[snap.docs.length - 1];
  }
  closedPage.loading = false;
}

/* ============== Data: Events (CRUD / Status) ============== */
/**
 * Neues Event anlegen (+ Standard- & Entwurfs-Produkte zuordnen)
 */
async function createEvent(payload, assignIds = []) {
  const now = serverTimestamp();

  // 1) Event-Dokument
  const evtRef = await addDoc(collection(db,"events"), {
    eventAt: payload.eventAt,
    deadlineAt: payload.deadlineAt,
    status: "offen",
    productsCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  const eventId = evtRef.id;

  try {
    // 2) Standards + Entwurf zusammenführen
    const stdSnap = await getDocs(query(
      collection(db, "products"),
      where("isStandard", "==", true)
    ));
    const stdIds = stdSnap.docs.map(d => d.id);
    const union = new Set([...stdIds, ...assignIds]);

    if (union.size) {
      // 3) Subcollection schreiben
      const writes = Array.from(union).map(pid => {
        const meta = allProducts.find(p => p.id === pid) || {};
        return setDoc(doc(db, "events", eventId, "products", pid), {
          productId: pid,
          categoryId: meta.categoryId || null,
          addedAsStandard: !!meta.isStandard,
          createdAt: serverTimestamp(),
        });
      });
      await Promise.all(writes);

      // 4) Counter setzen
      await updateDoc(evtRef, {
        productsCount: union.size,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("[createEvent] Zuordnung (Standards/Entwurf) fehlgeschlagen:", err);
  }

  return eventId;
}

async function updateEvent(id, payload) {
  await updateDoc(doc(db,"events", id), {
    eventAt: payload.eventAt,
    deadlineAt: payload.deadlineAt,
    updatedAt: serverTimestamp(),
  });
}

async function deleteEvent(id, status) {
  if (!(status === "offen" || status === "bestellbar")) {
    alert("Dieses Event kann in diesem Status nicht gelöscht werden (nur 'offen' oder 'bestellbar').");
    return;
  }
  const subSnap = await getDocs(collection(db, "events", id, "products"));
  await Promise.all(subSnap.docs.map(d => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "events", id));
}

/** Status setzen + in Listen verschieben */
async function setStatus(eventId, fromStatus, toStatus) {
  if (fromStatus === toStatus) return;

  await updateDoc(doc(db, "events", eventId), {
    status: toStatus,
    updatedAt: serverTimestamp(),
  });

  const moveIfNeeded = (arrFrom, arrTo) => {
    const i = arrFrom.findIndex(e => e.id === eventId);
    if (i < 0) return;
    arrFrom[i].status = toStatus;
    const wasOpen = OPEN_SET.has(fromStatus);
    const isOpen  = OPEN_SET.has(toStatus);
    if (wasOpen !== isOpen) {
      const [moved] = arrFrom.splice(i,1);
      if (moved && arrTo) arrTo.unshift(moved);
    }
  };

  if (OPEN_SET.has(fromStatus) && OPEN_SET.has(toStatus)) {
    const i = openPage.items.findIndex(e => e.id === eventId);
    if (i >= 0) openPage.items[i].status = toStatus;
  } else if (OPEN_SET.has(fromStatus) && CLOSED_SET.has(toStatus)) {
    moveIfNeeded(openPage.items, closedPage.items);
  } else if (CLOSED_SET.has(fromStatus) && OPEN_SET.has(toStatus)) {
    moveIfNeeded(closedPage.items, openPage.items);
  } else {
    const i = closedPage.items.findIndex(e => e.id === eventId);
    if (i >= 0) closedPage.items[i].status = toStatus;
  }

  renderAll();
}

/** Automatik: bestellbar → geschlossen, wenn Deadline vorbei */
async function autoClosePastDeadlines() {
  const now = Date.now();
  const candidates = openPage.items.filter(ev => {
    if (ev.status !== "bestellbar") return false;
    const d = toDate(ev.deadlineAt);
    return d && d.getTime() < now;
  });

  for (const ev of candidates) {
    try {
      await setStatus(ev.id, "bestellbar", "geschlossen");
    } catch (err) {
      console.error("Auto-Close fehlgeschlagen für", ev.id, err);
    }
  }
}

/* ============== Data: Products & Categories ============== */
async function loadAllProductsIfNeeded() {
  if (allProducts.length) return;
  const snap = await getDocs(query(collection(db,"products"), orderBy("name")));
  allProducts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function loadCategoriesIfNeeded() {
  if (categories.size) return;
  const snap = await getDocs(collection(db,"categories"));
  snap.forEach(d => {
    const data = d.data() || {};
    categories.set(d.id, data.name || d.id);
  });
}
async function loadAssignedProducts(eventId) {
  const snap = await getDocs(collection(db,"events", eventId, "products"));
  assigned = new Set(snap.docs.map(d => d.id));
}

/* ============== Produkte-Tab (gemeinsames Rendering) ============== */
const currentAssignedSet = () => (editId ? assigned : (draftAssigned || new Set()));
function computeAvailable() {
  const set = currentAssignedSet();
  return allProducts.filter(p => !set.has(p.id));
}
function filterAvailable(list) {
  const term = ($addSearch?.value || "").trim().toLowerCase();
  const onlyStd = !!$addOnlyStd?.checked;

  let rows = list;
  if (term) rows = rows.filter(p => (p.name || "").toLowerCase().includes(term));
  if (onlyStd) rows = rows.filter(p => !!p.isStandard);

  rows.sort((a,b)=> (a.name||"").localeCompare(b.name||"","de"));
  return rows.slice(0, 8); // kompakte Trefferliste
}
function renderAddResults() {
  if (!$addResultsTb) return;
  $addResultsTb.innerHTML = "";

  const editable = EDITABLE_SET.has(editStatus);
  const rows = filterAvailable(computeAvailable());

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.style.padding = ".5rem .75rem";
    td.style.color = "#666";
    td.textContent = "Keine passenden Produkte gefunden.";
    tr.appendChild(td); $addResultsTb.appendChild(tr);
    return;
  }

  for (const p of rows) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = p.name || "(ohne Namen)";

    const tdCat = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = categoryName(p.categoryId);
    tdCat.appendChild(badge);

    const tdAct = document.createElement("td");
    tdAct.innerHTML = `<a href="#" data-action="add" data-id="${p.id}" ${editable?"":'aria-disabled="true" style="pointer-events:none;opacity:.5"'}>[ + ]</a>`;

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdAct);
    $addResultsTb.appendChild(tr);
  }
}
function renderAssignedList() {
  if (!$assignedTb || !$assignedCount) return;
  $assignedTb.innerHTML = "";

  const editable = EDITABLE_SET.has(editStatus);
  const set = currentAssignedSet();

  const items = allProducts
    .filter(p => set.has(p.id))
    .sort((a,b)=> (a.name||"").localeCompare(b.name||"","de"));

  $assignedCount.textContent = String(items.length);

  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.style.padding = ".5rem .75rem";
    td.style.color = "#666";
    td.textContent = "Keine Produkte zugeordnet.";
    tr.appendChild(td); $assignedTb.appendChild(tr);
    return;
  }

  for (const p of items) {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = p.name || "(ohne Namen)";

    const tdCat = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = categoryName(p.categoryId);
    tdCat.appendChild(badge);

    const tdAct = document.createElement("td");
    tdAct.innerHTML = `<a href="#" data-action="remove" data-id="${p.id}" ${editable?"":'aria-disabled="true" style="pointer-events:none;opacity:.5"'}>[–]</a>`;

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdAct);
    $assignedTb.appendChild(tr);
  }
}

/** Produkte-Tab initialisieren (Edit vs. Create) */
async function initProductsTab(eventId, status) {
  await loadAllProductsIfNeeded();
  await loadCategoriesIfNeeded();

  editStatus = status;

  if (eventId) {
    await loadAssignedProducts(eventId);
  } else {
    if (!draftAssigned) {
      const stdSnap = await getDocs(query(collection(db,"products"), where("isStandard","==", true)));
      const stdIds = new Set(stdSnap.docs.map(d => d.id));
      draftAssigned = stdIds;
    }
  }

  renderAddResults();
  renderAssignedList();

  if (!productsUIBound) {
    $addSearch?.addEventListener("input", () => renderAddResults());
    $addOnlyStd?.addEventListener("change", () => renderAddResults());

    // Add
    $addResultsTb?.addEventListener("click", async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const btn = t.closest('a[data-action="add"]');
      if (!btn) return;
      e.preventDefault();
      if (!EDITABLE_SET.has(editStatus)) return;

      const pid = btn.getAttribute("data-id");
      if (!pid) return;

      if (editId) {
        if (assigned.has(pid)) return;
        try {
          const prod = allProducts.find(p => p.id === pid) || {};
          await setDoc(doc(db,"events", editId, "products", pid), {
            productId: pid,
            categoryId: prod.categoryId || null,
            addedAsStandard: !!prod.isStandard,
            createdAt: serverTimestamp(),
          });
          await updateDoc(doc(db,"events", editId), { productsCount: increment(1), updatedAt: serverTimestamp() });
          assigned.add(pid);
          bumpProductsCountInMainList(editId, +1);
        } catch (err) {
          console.error("Hinzufügen fehlgeschlagen:", err);
          alert("Hinzufügen fehlgeschlagen. Details in der Konsole.");
        }
      } else {
        draftAssigned ??= new Set();
        draftAssigned.add(pid);
      }

      renderAssignedList();
      renderAddResults();
    });

    // Remove
    $assignedTb?.addEventListener("click", async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const btn = t.closest('a[data-action="remove"]');
      if (!btn) return;
      e.preventDefault();
      if (!EDITABLE_SET.has(editStatus)) return;

      const pid = btn.getAttribute("data-id");
      if (!pid) return;

      if (editId) {
        if (!assigned.has(pid)) return;
        try {
          await deleteDoc(doc(db,"events", editId, "products", pid));
          await updateDoc(doc(db,"events", editId), { productsCount: increment(-1), updatedAt: serverTimestamp() });
          assigned.delete(pid);
          bumpProductsCountInMainList(editId, -1);
        } catch (err) {
          console.error("Entfernen fehlgeschlagen:", err);
          alert("Entfernen fehlgeschlagen. Details in der Konsole.");
        }
      } else {
        draftAssigned?.delete(pid);
      }

      renderAssignedList();
      renderAddResults();
    });

    productsUIBound = true;
  }
}

/* ============== Modal / Tabs / Render Listen ============== */
function switchTab(target){
  if (!$tabBtns || !$tabDetails || !$tabProducts) return;
  $tabBtns.forEach(b=>{
    const active = b.dataset.tab === target;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  $tabDetails.hidden  = target !== "details";
  $tabProducts.hidden = target !== "products";
}

function openModal(mode="create", data=null){
  if (!$modal) return;
  switchTab("details");

  if (mode==="edit" && data){
    editId = data.id;
    editStatus = data.status;
    draftAssigned = null;
    $modalTitle.textContent = "Event bearbeiten";

    const evD = toDate(data.eventAt);
    const dlD = toDate(data.deadlineAt);
    $eventDate.value    = evD ? evD.toISOString().slice(0,10) : "";
    $deadlineDate.value = dlD ? dlD.toISOString().slice(0,10) : ($eventDate.value || "");
    $deadlineTime.value = dlD ? dlD.toTimeString().slice(0,5) : "10:00";

    initProductsTab(editId, editStatus).catch(console.error);
  } else {
    editId = null;
    editStatus = "offen";
    $modalTitle.textContent = "Neues Event anlegen";
    $eventDate.value = "";
    $deadlineDate.value = "";
    $deadlineTime.value = "";
    draftAssigned = null;

    initProductsTab(null, "offen").catch(console.error);
  }

  $modal.classList.add("is-open");
  $eventDate.addEventListener("change", syncDeadlineDefaults, { once:true });

  $tabBtns.forEach(btn=>{
    btn.onclick = (e)=>{
      e.preventDefault();
      switchTab(btn.dataset.tab);
    };
  });

  setTimeout(()=> $eventDate?.focus(), 0);
}
function closeModal(){
  $modal?.classList.remove("is-open");
  editId=null;
  editStatus="offen";
  draftAssigned = null;
}

/* hübschere Labels & Badge-Klassen für Status */
const STATUS_LABEL = {
  offen: "Entwurf",
  bestellbar: "Veröffentlicht",
  geschlossen: "Bestellung geschlossen",
  rechnung_offen: "Rechnung offen",
  zahlung_offen: "Zahlung offen",
  abgerechnet: "Abgerechnet",
};
const STATUS_BADGE = {
  offen: "badge--offen",
  bestellbar: "badge--bestellbar",
  geschlossen: "badge--geschlossen",
  rechnung_offen: "badge--rechnung_offen",
  zahlung_offen: "badge--zahlung_offen",
  abgerechnet: "badge--abgerechnet",
};
function statusBadgeHTML(s) {
  const lbl = STATUS_LABEL[s] || s;
  const cls = STATUS_BADGE[s] || "badge--offen";
  return `<span class="badge ${cls}">${lbl}</span>`;
}
function editActionsHTML(ev) {
  const canDelete = ev.status==="offen" || ev.status==="bestellbar";
  const edit = `<a href="#" data-action="edit" data-id="${ev.id}">✏️</a>`;
  const del  = `<a href="#" data-action="delete" data-id="${ev.id}" ${canDelete?"":'aria-disabled="true"'}>🗑️</a>`;
  return `${edit} ${del}`;
}
function primaryActionHTML(ev) {
  if (ev.status === "offen")          return `<a href="#" data-action="publish" data-id="${ev.id}">Event veröffentlichen</a>`;
  if (ev.status === "geschlossen")    return `<a href="#" data-action="create-invoices" data-id="${ev.id}">Rechnung erstellen</a>`;
  if (ev.status === "rechnung_offen") return `<a href="#" data-action="send-invoices" data-id="${ev.id}">Rechnungen verschicken</a>`;
  return `<span style="color:#6b7280">–</span>`;
}

/** Tabellen-Rendering mit 6 Spalten */
function renderList(tbody, items, group){
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!items.length){
    const tr=document.createElement("tr"), td=document.createElement("td");
    td.colSpan=6; td.textContent="Keine Events gefunden";
    td.style.cssText="padding:.75rem;color:#666;text-align:center;";
    tr.appendChild(td); tbody.appendChild(tr); return;
  }

  for (const ev of items){
    const tr=document.createElement("tr");

    const tdDate=document.createElement("td");
    tdDate.textContent = fmtDate(toDate(ev.eventAt));

    const tdDead=document.createElement("td");
    tdDead.textContent = fmtDateTime(toDate(ev.deadlineAt));

    const tdStatus=document.createElement("td");
    tdStatus.innerHTML = statusBadgeHTML(ev.status);

    const tdCount=document.createElement("td");
    tdCount.textContent = ev.productsCount ?? 0;

    const tdEdit=document.createElement("td");
    tdEdit.className="row-actions";
    tdEdit.innerHTML = editActionsHTML(ev);

    const tdPrim=document.createElement("td");
    tdPrim.className="row-actions";
    tdPrim.innerHTML = primaryActionHTML(ev);

    tr.append(tdDate, tdDead, tdStatus, tdCount, tdEdit, tdPrim);
    tbody.appendChild(tr);
  }

  /* Delegation */
  tbody.querySelectorAll('a[data-action="edit"]').forEach(a=>{
    a.addEventListener("click",(e)=>{
      e.preventDefault();
      const id=a.getAttribute("data-id");
      const ev=(group==="open"?openPage.items:closedPage.items).find(x=>x.id===id);
      if (ev) openModal("edit", ev);
    });
  });

  // Publish: offen → bestellbar
  tbody.querySelectorAll('a[data-action="publish"]').forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      const id=a.getAttribute("data-id");
      const arr=(group==="open"?openPage.items:closedPage.items);
      const ev=arr.find(x=>x.id===id);
      if (!ev || ev.status!=="offen") return;
      try { await setStatus(id, "offen", "bestellbar"); } catch(err){ console.error(err); alert("Veröffentlichen fehlgeschlagen."); }
    });
  });

  // Rechnung erstellen: geschlossen → rechnung_offen
  tbody.querySelectorAll('a[data-action="create-invoices"]').forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      const id=a.getAttribute("data-id");
      const arr=(group==="open"?openPage.items:closedPage.items);
      const ev=arr.find(x=>x.id===id);
      if (!ev || ev.status!=="geschlossen") return;
      try { await setStatus(id, "geschlossen", "rechnung_offen"); } catch(err){ console.error(err); alert("Rechnungserstellung fehlgeschlagen."); }
    });
  });

  // Rechnungen verschicken: rechnung_offen → zahlung_offen
  tbody.querySelectorAll('a[data-action="send-invoices"]').forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      const id=a.getAttribute("data-id");
      const arr=(group==="open"?openPage.items:closedPage.items);
      const ev=arr.find(x=>x.id===id);
      if (!ev || ev.status!=="rechnung_offen") return;
      try { await setStatus(id, "rechnung_offen", "zahlung_offen"); } catch(err){ console.error(err); alert("Verschicken fehlgeschlagen."); }
    });
  });

  // Löschen
  tbody.querySelectorAll('a[data-action="delete"]').forEach(a=>{
    a.addEventListener("click", async (e)=>{
      e.preventDefault();
      const id=a.getAttribute("data-id");
      const arr=(group==="open"?openPage.items:closedPage.items);
      const ev=arr.find(x=>x.id===id); if (!ev) return;
      if (!(ev.status==="offen"||ev.status==="bestellbar")){
        alert("Nur Events im Status 'offen' oder 'bestellbar' dürfen gelöscht werden."); return;
      }
      if (!confirm("Event wirklich löschen? Zugeordnete Produkte werden ebenfalls entfernt.")) return;
      try{
        await deleteEvent(ev.id, ev.status);
        const i=arr.findIndex(x=>x.id===ev.id); if (i>=0) arr.splice(i,1);
        renderAll();
      }catch(err){ console.error(err); alert("Löschen fehlgeschlagen."); }
    });
  });
}

function bumpProductsCountInMainList(eventId, d){
  const upd=(arr)=>{ const i=arr.findIndex(e=>e.id===eventId); if(i>=0) arr[i].productsCount=(arr[i].productsCount||0)+d; };
  upd(openPage.items); upd(closedPage.items); renderAll();
}
function renderAll(){
  renderList($openTbody, openPage.items, "open");
  renderList($closedTbody, closedPage.items, "closed");

  if ($openMore){
    $openMore.disabled=openPage.loading||openPage.exhausted;
    $openMore.textContent=openPage.exhausted?"Keine weiteren Events":(openPage.loading?"Lade …":"Mehr laden");
  }
  if ($closedMore){
    $closedMore.disabled=closedPage.loading||closedPage.exhausted;
    $closedMore.textContent=closedPage.exhausted?"Keine weiteren Events":(closedPage.loading?"Lade …":"Mehr laden");
  }
}

/* ============== Bindings & Boot ============== */
function bindUI(){
  $btnNew?.addEventListener("click",(e)=>{ e.preventDefault(); openModal("create"); });

  $btnSave?.addEventListener("click", async (e)=>{
    e.preventDefault();
    const evDateStr=$eventDate?.value||"", dlDateStr=$deadlineDate?.value||"", dlTimeStr=$deadlineTime?.value||"";
    if(!evDateStr){ alert("Bitte ein Event-Datum wählen."); $eventDate?.focus(); return; }
    if(!dlDateStr||!dlTimeStr){ alert("Bitte Deadline (Datum und Uhrzeit) setzen."); (!$deadlineDate?.value?$deadlineDate:$deadlineTime)?.focus(); return; }
    const data={ eventAt: composeLocalDateTime(evDateStr,"00:00"), deadlineAt: composeLocalDateTime(dlDateStr, dlTimeStr) };
    if (!data.eventAt || !data.deadlineAt){ alert("Ungültiges Datum/Uhrzeit."); return; }

    try{
      if (editId){
        await updateEvent(editId, data);
        const upd=(arr)=>{ const i=arr.findIndex(x=>x.id===editId); if(i>=0){ arr[i].eventAt=data.eventAt; arr[i].deadlineAt=data.deadlineAt; } };
        upd(openPage.items); upd(closedPage.items);
        closeModal();
      } else {
        const assignIds = draftAssigned ? Array.from(draftAssigned) : [];
        await createEvent(data, assignIds);

        // Liste (offen) neu laden
        openPage={ items:[], lastDoc:null, exhausted:false, loading:false };
        await fetchOpenPage();

        closeModal();
      }
      renderAll();
      await autoClosePastDeadlines(); // direkt nach Speichern prüfen
    }catch(err){ console.error(err); alert("Speichern fehlgeschlagen."); }
  });

  $btnCancel?.addEventListener("click",(e)=>{ e.preventDefault(); closeModal(); });

  $modal?.addEventListener("click",(e)=>{ if(e.target===$modal) closeModal(); });
  document.addEventListener("keydown",(e)=>{ if(e.key==="Escape" && $modal.classList.contains("is-open")) closeModal(); });

  $openMore?.addEventListener("click", async ()=>{ await fetchOpenPage(); renderAll(); await autoClosePastDeadlines(); });
  $closedMore?.addEventListener("click", async ()=>{ await fetchClosedPage(); renderAll(); });
}

(async function boot(){
  try {
    await fetchOpenPage();
    await fetchClosedPage();
    bindUI();
    renderAll();

    // Auto-close beim Start + alle 60s
    await autoClosePastDeadlines();
    setInterval(autoClosePastDeadlines, 60000);

    console.log(`[events] offen:${openPage.items.length}, abgeschlossen:${closedPage.items.length}`);
  } catch (err) {
    console.error("Fehler beim Initialisieren der Events-Seite:", err);
    if ($openTbody)   $openTbody.innerHTML   = `<tr><td colspan="6" style="padding:.75rem;color:#b00;text-align:center;">Fehler beim Laden (offen)</td></tr>`;
    if ($closedTbody) $closedTbody.innerHTML = `<tr><td colspan="6" style="padding:.75rem;color:#b00;text-align:center;">Fehler beim Laden (abgeschlossen)</td></tr>`;
  }
})();
