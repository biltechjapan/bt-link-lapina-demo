(function () {
  "use strict";

  /*
   * auth.js は変更しない。同じ公開URLと publishable キーで、
   * ログイン済みセッションを共有するクライアントを作る。
   * service_role キーは使わない。RLSは回避しない。
   * gender と preferred_contact は許可値が未確認のため保存しない。
   * id、created_at、updated_at はクライアントから設定しない。
   * 患者番号はデータベースが登録時に発行する。新規INSERTと編集UPDATEには patient_no を含めない。
   */
  var SUPABASE_URL = "https://imhfdvscwsaizqvnnztl.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_f9VbCQbX_nMvzEmL1U9oZw_proWYzIl";

  var client = null;
  var patients = [];
  var locations = [];
  var locationRequest = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function blankToNull(value) {
    var text = trim(value);
    return text ? text : null;
  }

  function pageMessage(message) {
    var slot = $("page-message");
    if (slot) slot.textContent = message || "";
  }

  function formMessage(message) {
    var slot = $("form-message");
    if (slot) slot.textContent = message || "";
  }

  function locationMessage(message) {
    var slot = $("location-message");
    if (slot) slot.textContent = message || "";
  }

  function getClient() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("認証ライブラリを読み込めませんでした。");
    }
    if (!client) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return client;
  }

  function fullName(patient) {
    var parts = [];
    if (patient.last_name) parts.push(String(patient.last_name));
    if (patient.first_name) parts.push(String(patient.first_name));
    return parts.join(" ");
  }

  function phoneText(patient) {
    if (patient.phone) return String(patient.phone);
    if (patient.mobile_phone) return String(patient.mobile_phone);
    return "電話未登録";
  }

  function dateInput(value) {
    var text = value ? String(value) : "";
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  }

  function searchQuery() {
    return trim($("patient-search").value).toLowerCase();
  }

  function matchesSearch(patient, query) {
    if (!query) return true;
    var haystack = [patient.patient_no, patient.last_name, patient.first_name].join(" ").toLowerCase();
    return haystack.indexOf(query) !== -1;
  }

  function showStored(patient) {
    var slot = $("stored-unwritten");
    var lines = [];
    if (patient && patient.gender) lines.push("性別: " + patient.gender);
    if (patient && patient.preferred_contact) lines.push("希望連絡方法: " + patient.preferred_contact);
    slot.textContent = lines.join(" / ");
    slot.hidden = lines.length === 0;
  }

  function renderList() {
    var list = $("patient-list");
    var query = searchQuery();
    var selected = $("patient-form").getAttribute("data-id") || "";
    var visible = [];
    list.innerHTML = "";
    patients.forEach(function (patient) {
      if (matchesSearch(patient, query)) visible.push(patient);
    });
    if (!visible.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = patients.length ? "該当する患者はいません。" : "登録されている患者はいません。";
      list.appendChild(empty);
      return;
    }
    visible.forEach(function (patient) {
      var item = document.createElement("div");
      item.className = "patient-item";
      if (patient.id === selected) item.classList.add("is-selected");
      if (patient.is_active !== true) item.classList.add("is-inactive");

      var main = document.createElement("div");
      main.className = "patient-main";

      var number = document.createElement("span");
      number.className = "patient-no";
      number.textContent = patient.patient_no ? String(patient.patient_no) : "";

      var name = document.createElement("span");
      name.className = "patient-name";
      name.textContent = fullName(patient);

      var meta = document.createElement("span");
      meta.className = "patient-meta";
      meta.textContent = phoneText(patient) + " / " + (patient.is_active === true ? "有効" : "無効");

      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button-quiet";
      edit.textContent = "編集";
      edit.addEventListener("click", function () {
        fillForm(patient);
      });

      main.appendChild(number);
      main.appendChild(name);
      main.appendChild(meta);
      item.appendChild(main);
      item.appendChild(edit);
      list.appendChild(item);
    });
  }

  function clearForm() {
    var form = $("patient-form");
    form.removeAttribute("data-id");
    form.reset();
    $("is-active").checked = true;
    showStored(null);
    showPatientNumber(null);
    $("form-title").textContent = "患者の登録";
    formMessage("");
    renderList();
    hideLocations();
  }

  function fillForm(patient) {
    var form = $("patient-form");
    form.setAttribute("data-id", patient.id);
    showPatientNumber(patient.patient_no);
    $("last-name").value = patient.last_name || "";
    $("first-name").value = patient.first_name || "";
    $("last-name-kana").value = patient.last_name_kana || "";
    $("first-name-kana").value = patient.first_name_kana || "";
    $("birth-date").value = dateInput(patient.birth_date);
    $("postal-code").value = patient.postal_code || "";
    $("address").value = patient.address || "";
    $("phone").value = patient.phone || "";
    $("mobile-phone").value = patient.mobile_phone || "";
    $("email").value = patient.email || "";
    $("notes").value = patient.notes || "";
    $("is-active").checked = patient.is_active === true;
    showStored(patient);
    $("form-title").textContent = "患者の編集";
    formMessage("");
    renderList();
    openLocations(patient);
  }

  function loadPatients() {
    return getClient()
      .from("patients")
      .select("id, patient_no, last_name, first_name, last_name_kana, first_name_kana, birth_date, gender, postal_code, address, phone, mobile_phone, email, preferred_contact, notes, is_active")
      .order("patient_no", { ascending: true })
      .then(function (result) {
        if (result.error) throw result.error;
        patients = result.data || [];
        renderList();
      });
  }

  function showPatientNumber(patientNo) {
    var slot = $("patient-no");
    if (!slot) return;
    slot.textContent = patientNo ? String(patientNo) : "登録時に自動発行";
  }

  function payloadFromForm() {
    var lastName = trim($("last-name").value);
    var firstName = trim($("first-name").value);
    if (!lastName || !firstName) {
      return { error: "姓、名を入力してください。" };
    }
    return {
      values: {
        last_name: lastName,
        first_name: firstName,
        last_name_kana: blankToNull($("last-name-kana").value),
        first_name_kana: blankToNull($("first-name-kana").value),
        birth_date: blankToNull($("birth-date").value),
        postal_code: blankToNull($("postal-code").value),
        address: blankToNull($("address").value),
        phone: blankToNull($("phone").value),
        mobile_phone: blankToNull($("mobile-phone").value),
        email: blankToNull($("email").value),
        notes: blankToNull($("notes").value),
        is_active: $("is-active").checked
      }
    };
  }

  function saveForm(event) {
    event.preventDefault();
    var form = $("patient-form");
    var currentId = form.getAttribute("data-id") || "";
    var built = payloadFromForm();
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var submit = form.querySelector("[type='submit']");
    if (submit) submit.disabled = true;
    formMessage("");
    var query = getClient().from("patients");
    var request = currentId
      ? query.update(built.values).eq("id", currentId).select("id").single()
      : query.insert(built.values).select("id, patient_no").single();
    request.then(function (result) {
      if (result.error) throw result.error;
      if (currentId) {
        pageMessage("患者情報を更新しました。");
      } else {
        var issued = result.data && result.data.patient_no ? String(result.data.patient_no) : "";
        if (!issued) {
          clearForm();
          pageMessage("");
          formMessage("登録結果から患者番号を取得できませんでした。一覧を確認してください。");
          return loadPatients();
        }
        pageMessage("患者番号 " + issued + " で登録しました。");
      }
      clearForm();
      return loadPatients();
    }).catch(function (error) {
      formMessage(error && error.message ? error.message : "保存できませんでした。");
    }).then(function () {
      if (submit) submit.disabled = false;
    });
  }

  function selectedPatientId() {
    return $("patient-form").getAttribute("data-id") || "";
  }

  function hideLocations() {
    locationRequest += 1;
    locations = [];
    $("location-panel").hidden = true;
    $("location-list").innerHTML = "";
    $("location-patient").textContent = "";
    resetLocationForm();
  }

  function resetLocationForm() {
    var form = $("location-form");
    form.removeAttribute("data-id");
    form.reset();
    $("location-default").checked = false;
    $("location-form-title").textContent = "訪問先の登録";
    locationMessage("");
  }

  function renderLocations() {
    var list = $("location-list");
    var selected = $("location-form").getAttribute("data-id") || "";
    var patientId = selectedPatientId();
    list.innerHTML = "";
    if (!locations.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = "登録済みの訪問先はありません。";
      list.appendChild(empty);
      return;
    }
    locations.forEach(function (row) {
      if (row.patient_id !== patientId) return;
      var item = document.createElement("div");
      item.className = "patient-item";
      if (row.id === selected) item.classList.add("is-selected");

      var main = document.createElement("div");
      main.className = "patient-main";

      var name = document.createElement("span");
      name.className = "patient-name";
      name.textContent = row.location_name ? String(row.location_name) : "";

      var meta = document.createElement("span");
      meta.className = "patient-meta";
      meta.textContent = (row.address ? String(row.address) : "") + (row.is_default === true ? " / 既定" : "");

      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button-quiet";
      edit.textContent = "編集";
      edit.addEventListener("click", function () {
        fillLocation(row);
      });

      main.appendChild(name);
      main.appendChild(meta);
      item.appendChild(main);
      item.appendChild(edit);
      list.appendChild(item);
    });
  }

  function fillLocation(row) {
    if (!row || row.patient_id !== selectedPatientId()) {
      locationMessage("この訪問先は選択中の患者のものではありません。");
      return;
    }
    var form = $("location-form");
    form.setAttribute("data-id", row.id);
    $("location-name").value = row.location_name || "";
    $("location-postal-code").value = row.postal_code || "";
    $("location-address").value = row.address || "";
    $("location-contact").value = row.contact_name || "";
    $("location-phone").value = row.phone || "";
    $("location-notes").value = row.access_notes || "";
    $("location-default").checked = row.is_default === true;
    $("location-form-title").textContent = "訪問先の編集";
    locationMessage("");
    renderLocations();
  }

  function loadLocations(patientId) {
    var requestId = locationRequest + 1;
    locationRequest = requestId;
    locations = [];
    $("location-list").innerHTML = "";
    if (!patientId) return Promise.resolve();
    return getClient()
      .from("patient_locations")
      .select("id, patient_id, location_name, postal_code, address, contact_name, phone, access_notes, is_default")
      .eq("patient_id", patientId)
      .order("location_name", { ascending: true })
      .then(function (result) {
        if (requestId !== locationRequest) return;
        if (selectedPatientId() !== patientId) return;
        if (result.error) throw result.error;
        locations = (result.data || []).filter(function (row) {
          return row.patient_id === patientId;
        });
        renderLocations();
      });
  }

  function openLocations(patient) {
    $("location-panel").hidden = false;
    var labelParts = [];
    if (patient.patient_no) labelParts.push(String(patient.patient_no));
    if (fullName(patient)) labelParts.push(fullName(patient));
    $("location-patient").textContent = labelParts.join(" ");
    resetLocationForm();
    loadLocations(patient.id).catch(function (error) {
      locationMessage(error && error.message ? error.message : "訪問先を読み込めませんでした。");
    });
  }

  function findOtherDefault(patientId, currentId) {
    return getClient()
      .from("patient_locations")
      .select("id, patient_id")
      .eq("patient_id", patientId)
      .eq("is_default", true)
      .then(function (result) {
        if (result.error) throw result.error;
        var rows = result.data || [];
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].id !== currentId && rows[i].patient_id === patientId) return rows[i];
        }
        return null;
      });
  }

  function locationPayload(patientId) {
    var name = trim($("location-name").value);
    var address = trim($("location-address").value);
    if (!name || !address) {
      return { error: "訪問先名称と住所を入力してください。" };
    }
    return {
      values: {
        patient_id: patientId,
        location_name: name,
        postal_code: blankToNull($("location-postal-code").value),
        address: address,
        contact_name: blankToNull($("location-contact").value),
        phone: blankToNull($("location-phone").value),
        access_notes: blankToNull($("location-notes").value),
        is_default: $("location-default").checked
      }
    };
  }

  function saveLocation(event) {
    event.preventDefault();
    var patientId = selectedPatientId();
    if (!patientId) {
      locationMessage("先に患者を保存し、一覧の編集から選択してください。");
      return;
    }
    var built = locationPayload(patientId);
    if (built.error) {
      locationMessage(built.error);
      return;
    }
    var form = $("location-form");
    var currentId = form.getAttribute("data-id") || "";
    var submit = form.querySelector("[type='submit']");
    if (submit) submit.disabled = true;
    locationMessage("");
    var check = built.values.is_default ? findOtherDefault(patientId, currentId) : Promise.resolve(null);
    check.then(function (other) {
      if (other) {
        locationMessage("この患者には既定の訪問先が既にあります。先にその既定を外してから保存してください。");
        return null;
      }
      var query = getClient().from("patient_locations");
      if (currentId) {
        return query.update(built.values).eq("id", currentId).eq("patient_id", patientId).select("id, patient_id").single();
      }
      return query.insert(built.values).select("id, patient_id").single();
    }).then(function (result) {
      if (!result) return null;
      if (result.error) throw result.error;
      if (!result.data || result.data.patient_id !== patientId) {
        throw new Error("保存した訪問先が選択中の患者と一致しません。");
      }
      pageMessage(currentId ? "訪問先を更新しました。" : "訪問先を登録しました。");
      resetLocationForm();
      return loadLocations(patientId);
    }).catch(function (error) {
      locationMessage(error && error.message ? error.message : "訪問先を保存できませんでした。");
    }).then(function () {
      if (submit) submit.disabled = false;
    });
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    $("patient-search").addEventListener("input", renderList);
    $("patient-form").addEventListener("submit", saveForm);
    $("reset-button").addEventListener("click", function () {
      pageMessage("");
      clearForm();
    });
    $("location-form").addEventListener("submit", saveLocation);
    $("location-reset").addEventListener("click", function () {
      resetLocationForm();
      renderLocations();
    });
    var logout = $("logout-button");
    if (logout && window.LapinaAuth) {
      logout.addEventListener("click", function () {
        logout.disabled = true;
        window.LapinaAuth.signOut();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindUi();
    if (!window.LapinaAuth) return;
    window.LapinaAuth.requireAdmin().then(function (session) {
      if (!session) return;
      try {
        getClient();
      } catch (error) {
        pageMessage(error.message);
        return null;
      }
      showApp(session.user);
      return loadPatients();
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "患者管理を開けませんでした。");
    });
  });
})();
