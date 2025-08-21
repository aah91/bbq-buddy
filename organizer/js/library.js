// /organizer/js/library.js
import {
  db,
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from "../../firebase/firebase.js";

/* -------------------- DOM -------------------- */
const $search         = document.getElementById("search");
const $filterCategory = document.getElementById("filter-category");
const $filterStandard = document.getElementById("filter-standard");
const $sort           = document.getElementById("sort");
const $tbody          = document.querySelector(".table tbody");

// Modal-Elemente (Neues Produkt / Bearbeiten)
const $modal          = document.getElementById("new-product"); // <section id="new-product" class="modal">
const $modalTitle     = $modal?.querySelector("#modal-title");
const $inputName      = $modal?.querySelector("#prod-name");
const $selectCat      = $modal?.querySelector("#prod-cat");
const $checkStandard  = $modal?.querySelector("#prod-standard");
const $btnOpenModal   = document.querySelector('.toolbar a[href="#new-product"]'); // "+ Neues Produkt"
const $btnSave        = $modal?.querySelector(".modal-footer .btn.btn-primary");
const $btnCancel      = $modal?.querySelector(".modal-footer .btn:not(.btn-primary)");

/* -------------------- State -------------------- */
const categories = new Map(); // categoryId -> name
let products = [];            // Array<Product>
let editId = null;            // null = create, ansonsten Firestore-Dokument-ID

/* -------------------- Utils -------------------- */
const isTimestamp = (v) =>
  v && (typeof v.toDate === "function" || typeof v.toMillis === "function");

const toDateStringDE = (v) => {
  if (!v) return "—";
  if (isTimestamp(v)) {
    const d = v.toDate ? v.toDate() : new Date(v.toMillis());
    return d.toLocaleDateString("de-DE");
  }
  if (v instanceof Date) return v.toLocaleDateString("de-DE");
  const d = new Date(v);
  return isNaN(d) ? "—" : d.toLocaleDateString("de-DE");
};

const debounce = (fn, ms = 150) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* -------------------- Modal helpers (mit .is-open) -------------------- */
function openModal(mode = "create", docData = null) {
  if (!$modal) return;

  // Kategorie-Dropdown im Modal frisch auffüllen
  if ($selectCat) {
    $selectCat.innerHTML = "";
    for (const [id, name] of categories.entries()) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      $selectCat.appendChild(opt);
    }
  }

  if (mode === "edit" && docData) {
    editId = docData.id;
    if ($modalTitle) $modalTitle.textContent = "Produkt bearbeiten";
    if ($inputName) $inputName.value = docData.name || "";
    if ($selectCat) $selectCat.value = docData.categoryId || ($selectCat.options[0]?.value ?? "");
    if ($checkStandard) $checkStandard.checked = !!docData.isStandard;
  } else {
    editId = null;
    if ($modalTitle) $modalTitle.textContent = "Neues Produkt anlegen";
    if ($inputName) $inputName.value = "";
    if ($selectCat) $selectCat.selectedIndex = 0;
    if ($checkStandard) $checkStandard.checked = false;
  }

  // anzeigen via Klasse
  $modal.classList.add("is-open");
  // Fokus auf erstes Feld
  setTimeout(() => $inputName?.focus(), 0);
}

function closeModal() {
  if ($modal) $modal.classList.remove("is-open");
  editId = null;
}

function validateProductForm() {
  const name = ($inputName?.value || "").trim();
  const categoryId = $selectCat?.value || "";
  if (!name) {
    alert("Bitte einen Produktnamen eingeben.");
    $inputName?.focus();
    return null;
  }
  if (!categoryId) {
    alert("Bitte eine Kategorie wählen.");
    $selectCat?.focus();
    return null;
  }
  return {
    name,
    categoryId,
    isStandard: !!$checkStandard?.checked,
  };
}

/* -------------------- Loaders -------------------- */
async function loadCategories() {
  const snap = await getDocs(collection(db, "categories"));
  categories.clear();
  snap.forEach((d) => {
    const data = d.data() || {};
    categories.set(d.id, data.name || d.id);
  });

  // Filter-Dropdown auf der Seite (Option[0] = "Alle" behalten, Rest neu füllen)
  if ($filterCategory) {
    for (let i = $filterCategory.options.length - 1; i >= 1; i--) {
      $filterCategory.remove(i);
    }
    for (const [id, name] of categories.entries()) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      $filterCategory.appendChild(opt);
    }
  }
}

async function loadProducts() {
  const q = query(collection(db, "products"), orderBy("name"));
  const snap = await getDocs(q);
  products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* -------------------- Writes -------------------- */
async function createProduct(data) {
  const now = serverTimestamp();
  await addDoc(collection(db, "products"), {
    name: data.name,
    categoryId: data.categoryId,
    isStandard: !!data.isStandard,
    createdAt: now,
    updatedAt: now,
  });
}

async function updateProduct(id, data) {
  const ref = doc(db, "products", id);
  await updateDoc(ref, {
    name: data.name,
    categoryId: data.categoryId,
    isStandard: !!data.isStandard,
    updatedAt: serverTimestamp(),
  });
}

async function removeProduct(id) {
  const ref = doc(db, "products", id);
  await deleteDoc(ref);
}

/* -------------------- Render -------------------- */
function render() {
  if (!$tbody) return;

  const term = ($search?.value || "").trim().toLowerCase();
  const categoryId = $filterCategory?.value || "";
  const onlyStd = !!$filterStandard?.checked;

  let rows = products.slice();

  if (term) rows = rows.filter((p) => (p.name || "").toLowerCase().includes(term));
  if (categoryId) rows = rows.filter((p) => p.categoryId === categoryId);
  if (onlyStd) rows = rows.filter((p) => !!p.isStandard);

  // Sortierung
  const sort = $sort?.value || "name-asc";
  rows.sort((a, b) => {
    const nameA = (a.name || "").toLowerCase();
    const nameB = (b.name || "").toLowerCase();
    const catA = (categories.get(a.categoryId) || "").toLowerCase();
    const catB = (categories.get(b.categoryId) || "").toLowerCase();
    const tsA = isTimestamp(a.updatedAt)
      ? (a.updatedAt.toMillis ? a.updatedAt.toMillis() : a.updatedAt.toDate().getTime())
      : 0;
    const tsB = isTimestamp(b.updatedAt)
      ? (b.updatedAt.toMillis ? b.updatedAt.toMillis() : b.updatedAt.toDate().getTime())
      : 0;

    switch (sort) {
      case "name-asc":     return nameA.localeCompare(nameB);
      case "name-desc":    return nameB.localeCompare(nameA);
      case "cat-asc":      return catA.localeCompare(catB) || nameA.localeCompare(nameB);
      case "changed-desc": return tsB - tsA || nameA.localeCompare(nameB);
      default:             return nameA.localeCompare(nameB);
    }
  });

  // Tabelle leeren
  $tbody.innerHTML = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "Keine Produkte gefunden";
    td.style.color = "#666";
    td.style.textAlign = "center";
    td.style.padding = "0.75rem";
    tr.appendChild(td);
    $tbody.appendChild(tr);
    return;
  }

  for (const p of rows) {
    const tr = document.createElement("tr");

    // Auswahl
    const tdSel = document.createElement("td");
    tdSel.innerHTML = `<input type="checkbox" aria-label="Produkt auswählen">`;

    // Name
    const tdName = document.createElement("td");
    const a = document.createElement("a");
    a.href = "#detail";
    a.textContent = p.name || "(ohne Namen)";
    tdName.appendChild(a);

    // Kategorie
    const tdCat = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = categories.get(p.categoryId) || p.categoryId || "—";
    tdCat.appendChild(badge);

    // Standard
    const tdStd = document.createElement("td");
    const std = document.createElement("input");
    std.type = "checkbox";
    std.disabled = true;
    std.checked = !!p.isStandard;
    std.setAttribute("aria-label", "Standard");
    tdStd.appendChild(std);

    // Geändert
    const tdChanged = document.createElement("td");
    tdChanged.textContent = toDateStringDE(p.updatedAt);

    // Aktionen
    const tdActions = document.createElement("td");
    tdActions.className = "row-actions";
    tdActions.innerHTML = `
      <a href="#" data-action="edit" data-id="${p.id}">Bearbeiten</a>
      ·
      <a href="#" data-action="delete" data-id="${p.id}">Löschen</a>
    `;

    tr.appendChild(tdSel);
    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdStd);
    tr.appendChild(tdChanged);
    tr.appendChild(tdActions);

    $tbody.appendChild(tr);
  }

  // Aktionen binden (nach Render)
  $tbody.querySelectorAll('a[data-action="edit"]').forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const id = el.getAttribute("data-id");
      const docData = products.find((x) => x.id === id);
      if (docData) openModal("edit", docData);
    });
  });

  $tbody.querySelectorAll('a[data-action="delete"]').forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = el.getAttribute("data-id");
      const docData = products.find((x) => x.id === id);
      if (!docData) return;
      const ok = confirm(`„${docData.name}“ wirklich löschen?`);
      if (!ok) return;
      try {
        await removeProduct(id);
        await loadProducts();
        render();
      } catch (err) {
        console.error("Löschen fehlgeschlagen:", err);
        alert("Löschen fehlgeschlagen. Details in der Konsole.");
      }
    });
  });
}

/* -------------------- Bindings -------------------- */
function bindControls() {
  const debouncedRender = debounce(render, 150);
  [$search, $filterCategory, $filterStandard, $sort].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", debouncedRender);
    el.addEventListener("change", debouncedRender);
  });

  // Modal öffnen (Neues Produkt)
  if ($btnOpenModal && $modal) {
    $btnOpenModal.addEventListener("click", (e) => {
      e.preventDefault(); // verhindert #jump
      openModal("create");
    });
  }

  // Modal speichern
  if ($btnSave && $modal) {
    $btnSave.addEventListener("click", async (e) => {
      e.preventDefault();
      const data = validateProductForm();
      if (!data) return;
      try {
        if (editId) {
          await updateProduct(editId, data);
        } else {
          await createProduct(data);
        }
        closeModal();
        await loadProducts();
        render();
      } catch (err) {
        console.error("Speichern fehlgeschlagen:", err);
        alert("Speichern fehlgeschlagen. Details in der Konsole.");
      }
    });
  }

  // Modal schließen (Abbrechen oder Klick auf Hintergrund)
  if ($btnCancel && $modal) {
    $btnCancel.addEventListener("click", (e) => {
      e.preventDefault();
      closeModal();
    });
  }
  if ($modal) {
    // Klick außerhalb des Dialogs schließt Modal
    $modal.addEventListener("click", (e) => {
      if (e.target === $modal) closeModal();
    });
    // ESC schließt Modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $modal.classList.contains("is-open")) {
        closeModal();
      }
    });
  }
}

/* -------------------- Boot -------------------- */
(async function boot() {
  try {
    await loadCategories();
    await loadProducts();
    bindControls();
    render();
    console.log(`[library] ${products.length} Produkte geladen.`);
  } catch (err) {
    console.error("Fehler beim Laden der Produkte/Kategorien:", err);
    if ($tbody) {
      $tbody.innerHTML =
        `<tr><td colspan="6" style="padding:0.75rem;color:#b00;text-align:center;">` +
        `Fehler beim Laden der Daten</td></tr>`;
    }
  }
})();
