(function () {
  "use strict";

  /*
   * auth.js は変更しない。公開URLと publishable キーで
   * ログイン済みセッションを共有する。RLSは回避しない。
   * practitioner_id は送らない。料金の自動算定はしない。
   * 削除はしない。確定済みは内容を更新しない。
   */
  var SUPABASE_URL = "https://imhfdvscwsaizqvnnztl.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_f9VbCQbX_nMvzEmL1U9oZw_proWYzIl";

  var TREATMENT = {
    massage: "マッサージ",
    acupuncture: "鍼",
    moxibustion: "灸",
    combined: "併用",
    other: "その他"
  };
  var PLACE = { clinic: "店舗", visit: "訪問" };
  var PAYMENT = { insurance: "保険", private: "自費" };
  var STATUS = { draft: "下書き", confirmed: "確定", cancelled: "キャンセル" };
  var ITEM = {
    massage_local: "マッサージ（局所）",
    corrective_manipulation: "変形徒手矯正術",
    hot_pack: "温罨法",
    hot_pack_device: "温罨法・電気光線器具",
    initial_exam: "初検料",
    acupuncture: "はり",
    moxibustion: "きゅう",
    combined_treatment: "はり・きゅう併用",
    electrotherapy: "電療料",
    travel: "往療"
  };
  var BODY = {
    trunk: "躯幹",
    right_upper_limb: "右上肢",
    left_upper_limb: "左上肢",
    right_lower_limb: "右下肢",
    left_lower_limb: "左下肢"
  };
  var BODY_ITEMS = { massage_local: true, corrective_manipulation: true };
  var RECORD_COLUMNS = "id, patient_id, location_id, treatment_date, visit_type, treatment_type, payment_type, status, notes";

  var client = null;
  var patients = [];
  var locations = [];
  var records = [];
  var details = [];
  var locationRequest = 0;
  var detailRequest = 0;

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

  function label(map, value) {
    return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value || "";
  }

  function pageMessage(message) {
    var slot = $("page-message");
    if (slot) slot.textContent = message || "";
  }

  function formMessage(message) {
    var slot = $("form-message");
    if (slot) slot.textContent = message || "";
  }

  function detailMessage(message) {
    var slot = $("detail-message");
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

  function selectedPatientId() {
    return $("patient-id").value || "";
  }

  function selectedRecordId() {
    return $("record-form").getAttribute("data-id") || "";
  }

  function currentRecord() {
    var id = selectedRecordId();
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].id === id) return records[i];
    }
    return null;
  }

  function patientLabel(patient) {
    var parts = [];
    if (patient.patient_no) parts.push(String(patient.patient_no));
    if (patient.last_name) parts.push(String(patient.last_name));
    if (patient.first_name) parts.push(String(patient.first_name));
    if (patient.is_active !== true) parts.push("（無効）");
    return parts.join(" ");
  }

  function dateInput(value) {
    var text = value ? String(value) : "";
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  }

  function needsBody(itemType) {
    return !!BODY_ITEMS[itemType];
  }

  function parseCount(value, name, allowZero) {
    var text = trim(value);
    if (!text) return { error: name + "を入力してください。" };
    if (!/^\d+$/.test(text)) return { error: name + "は0以上の整数で入力してください。" };
    var number = Number(text);
    if (!allowZero && number < 1) return { error: name + "は1以上で入力してください。" };
    return { value: number };
  }

  function fillPatients() {
    var select = $("patient-id");
    var current = select.value;
    select.innerHTML = "";
    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "選択してください";
    select.appendChild(empty);
    patients.forEach(function (patient) {
      var option = document.createElement("option");
      option.value = patient.id;
      option.textContent = patientLabel(patient);
      select.appendChild(option);
    });
    select.value = current;
  }

  function fillLocations(selectedId) {
    var select = $("location-id");
    select.innerHTML = "";
    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = locations.length ? "選択してください" : "登録済みの訪問先がありません";
    select.appendChild(empty);
    locations.forEach(function (location) {
      var option = document.createElement("option");
      option.value = location.id;
      option.textContent = location.location_name ? String(location.location_name) : "名称未設定";
      select.appendChild(option);
    });
    if (selectedId) select.value = selectedId;
  }

  function syncLocationField() {
    var isVisit = $("visit-type").value === "visit";
    var editable = !$("record-fields").disabled;
    $("location-field").hidden = !isVisit;
    $("location-id").required = isVisit && editable;
    if (!isVisit) $("location-id").value = "";
  }

  function syncBodyField() {
    var show = needsBody($("item-type").value);
    var editable = !$("detail-fields").disabled;
    $("body-part-field").hidden = !show;
    $("body-part").required = show && editable;
    if (!show) $("body-part").value = "";
  }

  function setRecordMode(status) {
    var draft = !status || status === "draft";
    var confirmed = status === "confirmed";
    $("record-fields").disabled = !draft;
    $("record-save").hidden = !draft;
    $("record-reset").hidden = !draft;
    $("record-cancel").hidden = !confirmed;
    $("record-lock").hidden = draft;
    $("record-lock").textContent = confirmed
      ? "確定済みのため、内容は変更できません。キャンセルだけできます。"
      : "キャンセル済みのため、変更できません。";
    syncLocationField();
  }

  function setDetailMode(editable) {
    $("detail-fields").disabled = !editable;
    $("detail-save").hidden = !editable;
    $("detail-reset").hidden = !editable;
    syncBodyField();
  }

  function renderRecords() {
    var list = $("record-list");
    var selected = selectedRecordId();
    list.innerHTML = "";
    if (!selectedPatientId()) {
      var choose = document.createElement("p");
      choose.className = "patient-empty";
      choose.textContent = "患者を選択してください。";
      list.appendChild(choose);
      return;
    }
    if (!records.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = "この患者の施術記録はありません。";
      list.appendChild(empty);
      return;
    }
    records.forEach(function (row) {
      var item = document.createElement("div");
      item.className = "patient-item";
      if (row.id === selected) item.classList.add("is-selected");
      if (row.status === "cancelled") item.classList.add("is-inactive");

      var main = document.createElement("div");
      main.className = "patient-main";
      var date = document.createElement("span");
      date.className = "patient-no";
      date.textContent = dateInput(row.treatment_date);
      var name = document.createElement("span");
      name.className = "patient-name";
      name.textContent = label(TREATMENT, row.treatment_type);
      var meta = document.createElement("span");
      meta.className = "patient-meta";
      meta.textContent = [
        label(PLACE, row.visit_type),
        label(PAYMENT, row.payment_type),
        label(STATUS, row.status)
      ].join(" / ");
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button-quiet";
      edit.textContent = "編集";
      edit.addEventListener("click", function () {
        fillRecord(row);
      });
      main.appendChild(date);
      main.appendChild(name);
      main.appendChild(meta);
      item.appendChild(main);
      item.appendChild(edit);
      list.appendChild(item);
    });
  }

  function renderDetails() {
    var list = $("detail-list");
    var selected = $("detail-form").getAttribute("data-id") || "";
    var recordId = selectedRecordId();
    list.innerHTML = "";
    if (!details.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = "登録済みの明細はありません。";
      list.appendChild(empty);
      return;
    }
    details.forEach(function (row) {
      if (row.treatment_record_id !== recordId) return;
      var item = document.createElement("div");
      item.className = "patient-item";
      if (row.id === selected) item.classList.add("is-selected");
      var main = document.createElement("div");
      main.className = "patient-main";
      var name = document.createElement("span");
      name.className = "patient-name";
      name.textContent = label(ITEM, row.item_type);
      var meta = document.createElement("span");
      meta.className = "patient-meta";
      var parts = [];
      if (row.body_part) parts.push(label(BODY, row.body_part));
      parts.push("数量 " + row.quantity);
      parts.push("金額 " + row.amount);
      meta.textContent = parts.join(" / ");
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button-quiet";
      edit.textContent = "編集";
      edit.disabled = !(currentRecord() && currentRecord().status === "draft");
      edit.addEventListener("click", function () {
        fillDetail(row);
      });
      main.appendChild(name);
      main.appendChild(meta);
      item.appendChild(main);
      item.appendChild(edit);
      list.appendChild(item);
    });
  }

  function resetDetailForm() {
    var form = $("detail-form");
    form.removeAttribute("data-id");
    form.reset();
    $("detail-quantity").value = "1";
    $("detail-form-title").textContent = "明細の登録";
    detailMessage("");
    syncBodyField();
  }

  function resetRecordForm() {
    var form = $("record-form");
    form.removeAttribute("data-id");
    form.reset();
    $("visit-type").value = "clinic";
    $("record-status").value = "draft";
    $("form-title").textContent = "施術の登録";
    formMessage("");
    setRecordMode("draft");
    fillLocations("");
    hideDetails();
    renderRecords();
  }

  function hideDetails() {
    detailRequest += 1;
    details = [];
    $("detail-panel").hidden = true;
    $("detail-list").innerHTML = "";
    $("detail-record").textContent = "";
    resetDetailForm();
  }

  function fillRecord(row) {
    if (!row || row.patient_id !== selectedPatientId()) {
      formMessage("この施術記録は選択中の患者のものではありません。");
      return;
    }
    var form = $("record-form");
    form.setAttribute("data-id", row.id);
    $("treatment-date").value = dateInput(row.treatment_date);
    $("treatment-type").value = row.treatment_type || "";
    $("visit-type").value = row.visit_type || "clinic";
    $("payment-type").value = row.payment_type || "";
    $("record-status").value = row.status || "draft";
    $("record-notes").value = row.notes || "";
    $("form-title").textContent = "施術の編集";
    formMessage("");
    setRecordMode(row.status);
    renderRecords();
    openDetails(row);
    if (row.visit_type === "visit") {
      loadLocations(row.patient_id, row.location_id || "").catch(function (error) {
        formMessage(error && error.message ? error.message : "訪問先を読み込めませんでした。");
      });
    } else {
      fillLocations("");
    }
  }

  function fillDetail(row) {
    var record = currentRecord();
    if (!record || record.status !== "draft" || row.treatment_record_id !== record.id) {
      detailMessage("下書きの施術記録の明細だけ編集できます。");
      return;
    }
    var form = $("detail-form");
    form.setAttribute("data-id", row.id);
    $("item-type").value = row.item_type || "";
    $("body-part").value = row.body_part || "";
    $("detail-quantity").value = row.quantity === 0 || row.quantity ? String(row.quantity) : "1";
    $("detail-unit-fee").value = row.unit_fee === 0 || row.unit_fee ? String(row.unit_fee) : "";
    $("detail-amount").value = row.amount === 0 || row.amount ? String(row.amount) : "";
    $("fee-schedule").value = row.fee_schedule || "";
    $("detail-notes").value = row.notes || "";
    $("detail-form-title").textContent = "明細の編集";
    detailMessage("");
    syncBodyField();
    renderDetails();
  }

  function loadPatients() {
    return getClient()
      .from("patients")
      .select("id, patient_no, last_name, first_name, is_active")
      .order("patient_no", { ascending: true })
      .then(function (result) {
        if (result.error) throw result.error;
        patients = result.data || [];
        fillPatients();
      });
  }

  function loadLocations(patientId, selectedId) {
    var requestId = locationRequest + 1;
    locationRequest = requestId;
    locations = [];
    fillLocations("");
    if (!patientId || $("visit-type").value !== "visit") return Promise.resolve();
    return getClient()
      .from("patient_locations")
      .select("id, patient_id, location_name")
      .eq("patient_id", patientId)
      .order("location_name", { ascending: true })
      .then(function (result) {
        if (requestId !== locationRequest) return;
        if (result.error) throw result.error;
        locations = (result.data || []).filter(function (row) {
          return row.patient_id === patientId;
        });
        fillLocations(selectedId || "");
      });
  }

  function loadRecords(patientId) {
    records = [];
    renderRecords();
    if (!patientId) return Promise.resolve();
    return getClient()
      .from("treatment_records")
      .select(RECORD_COLUMNS)
      .eq("patient_id", patientId)
      .order("treatment_date", { ascending: false })
      .order("created_at", { ascending: false })
      .then(function (result) {
        if (selectedPatientId() !== patientId) return;
        if (result.error) throw result.error;
        records = (result.data || []).filter(function (row) {
          return row.patient_id === patientId;
        });
        renderRecords();
      });
  }

  function loadDetails(recordId) {
    var requestId = detailRequest + 1;
    detailRequest = requestId;
    details = [];
    $("detail-list").innerHTML = "";
    if (!recordId) return Promise.resolve();
    return getClient()
      .from("treatment_details")
      .select("id, treatment_record_id, line_no, item_type, body_part, quantity, unit_fee, amount, fee_schedule, notes")
      .eq("treatment_record_id", recordId)
      .order("line_no", { ascending: true })
      .then(function (result) {
        if (requestId !== detailRequest) return;
        if (selectedRecordId() !== recordId) return;
        if (result.error) throw result.error;
        details = (result.data || []).filter(function (row) {
          return row.treatment_record_id === recordId;
        });
        renderDetails();
      });
  }

  function openDetails(row) {
    $("detail-panel").hidden = false;
    $("detail-record").textContent = dateInput(row.treatment_date) + " " + label(TREATMENT, row.treatment_type);
    resetDetailForm();
    setDetailMode(row.status === "draft");
    loadDetails(row.id).catch(function (error) {
      detailMessage(error && error.message ? error.message : "明細を読み込めませんでした。");
    });
  }

  function recordPayload(patientId) {
    var treatmentDate = $("treatment-date").value;
    var treatmentType = $("treatment-type").value;
    var visitType = $("visit-type").value;
    var paymentType = $("payment-type").value;
    var status = $("record-status").value;
    if (!treatmentDate || !treatmentType || !visitType || !paymentType || !status) {
      return { error: "施術日、施術区分、施術場所、支払区分、施術状態を入力してください。" };
    }
    if (!TREATMENT[treatmentType] || !PLACE[visitType] || !PAYMENT[paymentType] || !STATUS[status]) {
      return { error: "選択内容を確認してください。" };
    }
    if (visitType === "visit" && !$("location-id").value) {
      return { error: "訪問の場合は、その患者の訪問先を選択してください。" };
    }
    return {
      values: {
        patient_id: patientId,
        location_id: visitType === "visit" ? $("location-id").value : null,
        treatment_date: treatmentDate,
        visit_type: visitType,
        treatment_type: treatmentType,
        payment_type: paymentType,
        status: status,
        notes: blankToNull($("record-notes").value)
      }
    };
  }

  function saveRecord(event) {
    event.preventDefault();
    var patientId = selectedPatientId();
    if (!patientId) {
      formMessage("患者を選択してください。");
      return;
    }
    var existing = currentRecord();
    if (existing && existing.status !== "draft") {
      formMessage("確定済みまたはキャンセル済みの施術記録は変更できません。");
      return;
    }
    var built = recordPayload(patientId);
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var form = $("record-form");
    var currentId = form.getAttribute("data-id") || "";
    var submit = $("record-save");
    submit.disabled = true;
    formMessage("");
    var query = getClient().from("treatment_records");
    var request = currentId
      ? query.update(built.values).eq("id", currentId).eq("patient_id", patientId).eq("status", "draft").select(RECORD_COLUMNS).single()
      : query.insert(built.values).select(RECORD_COLUMNS).single();
    request.then(function (result) {
      if (result.error) throw result.error;
      if (!result.data || result.data.patient_id !== patientId) {
        throw new Error("保存した施術記録が選択中の患者と一致しません。");
      }
      pageMessage(currentId ? "施術記録を更新しました。" : "施術記録を登録しました。");
      return loadRecords(patientId).then(function () {
        fillRecord(result.data);
      });
    }).catch(function (error) {
      formMessage(error && error.message ? error.message : "施術記録を保存できませんでした。");
    }).then(function () {
      submit.disabled = false;
    });
  }

  function cancelRecord() {
    var row = currentRecord();
    if (!row || row.status !== "confirmed") return;
    if (!window.confirm("この確定済みの施術をキャンセルしますか？記録は削除しません。")) return;
    var button = $("record-cancel");
    button.disabled = true;
    getClient()
      .from("treatment_records")
      .update({ status: "cancelled" })
      .eq("id", row.id)
      .eq("patient_id", row.patient_id)
      .eq("status", "confirmed")
      .select(RECORD_COLUMNS)
      .single()
      .then(function (result) {
        if (result.error) throw result.error;
        pageMessage("施術記録をキャンセルしました。");
        return loadRecords(row.patient_id).then(function () {
          fillRecord(result.data);
        });
      })
      .catch(function (error) {
        formMessage(error && error.message ? error.message : "キャンセルできませんでした。");
      })
      .then(function () {
        button.disabled = false;
      });
  }

  function nextLineNo() {
    var max = 0;
    details.forEach(function (row) {
      if (row.line_no > max) max = row.line_no;
    });
    return max + 1;
  }

  function detailPayload(recordId) {
    var itemType = $("item-type").value;
    if (!ITEM[itemType]) return { error: "明細区分を選択してください。" };
    var bodyPart = needsBody(itemType) ? $("body-part").value : "";
    if (needsBody(itemType) && !BODY[bodyPart]) return { error: "局所を選択してください。" };
    var quantity = parseCount($("detail-quantity").value, "数量", false);
    if (quantity.error) return quantity;
    var amount = parseCount($("detail-amount").value, "金額", true);
    if (amount.error) return amount;
    var unitText = trim($("detail-unit-fee").value);
    var unitFee = null;
    if (unitText) {
      var parsed = parseCount(unitText, "単価", true);
      if (parsed.error) return parsed;
      unitFee = parsed.value;
    }
    var currentId = $("detail-form").getAttribute("data-id") || "";
    var lineNo = 0;
    if (currentId) {
      for (var i = 0; i < details.length; i += 1) {
        if (details[i].id === currentId) lineNo = details[i].line_no;
      }
    }
    if (!lineNo) lineNo = nextLineNo();
    return {
      values: {
        treatment_record_id: recordId,
        line_no: lineNo,
        item_type: itemType,
        body_part: bodyPart || null,
        quantity: quantity.value,
        unit_fee: unitFee,
        amount: amount.value,
        fee_schedule: blankToNull($("fee-schedule").value),
        notes: blankToNull($("detail-notes").value)
      }
    };
  }

  function saveDetail(event) {
    event.preventDefault();
    var record = currentRecord();
    if (!record || record.status !== "draft") {
      detailMessage("下書きの施術記録にだけ明細を保存できます。");
      return;
    }
    var built = detailPayload(record.id);
    if (built.error) {
      detailMessage(built.error);
      return;
    }
    var currentId = $("detail-form").getAttribute("data-id") || "";
    var submit = $("detail-save");
    submit.disabled = true;
    detailMessage("");
    getClient()
      .from("treatment_records")
      .select("id, status, patient_id")
      .eq("id", record.id)
      .eq("patient_id", record.patient_id)
      .single()
      .then(function (result) {
        if (result.error) throw result.error;
        if (!result.data || result.data.status !== "draft") {
          throw new Error("確定済みまたはキャンセル済みの施術記録には明細を保存できません。");
        }
        var query = getClient().from("treatment_details");
        if (currentId) {
          return query.update(built.values).eq("id", currentId).eq("treatment_record_id", record.id).select("id").single();
        }
        return query.insert(built.values).select("id").single();
      })
      .then(function (result) {
        if (!result) return null;
        if (result.error) throw result.error;
        pageMessage(currentId ? "明細を更新しました。" : "明細を登録しました。");
        resetDetailForm();
        return loadDetails(record.id);
      })
      .catch(function (error) {
        detailMessage(error && error.message ? error.message : "明細を保存できませんでした。");
      })
      .then(function () {
        submit.disabled = false;
      });
  }

  function onPatientChange() {
    pageMessage("");
    resetRecordForm();
    var patientId = selectedPatientId();
    loadLocations(patientId, "").catch(function (error) {
      formMessage(error && error.message ? error.message : "訪問先を読み込めませんでした。");
    });
    loadRecords(patientId).catch(function (error) {
      pageMessage(error && error.message ? error.message : "施術記録を読み込めませんでした。");
    });
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  function bindUi() {
    $("patient-id").addEventListener("change", onPatientChange);
    $("visit-type").addEventListener("change", function () {
      syncLocationField();
      if ($("visit-type").value === "visit") {
        loadLocations(selectedPatientId(), "").catch(function (error) {
          formMessage(error && error.message ? error.message : "訪問先を読み込めませんでした。");
        });
      }
    });
    $("item-type").addEventListener("change", syncBodyField);
    $("record-form").addEventListener("submit", saveRecord);
    $("record-reset").addEventListener("click", function () {
      pageMessage("");
      resetRecordForm();
    });
    $("record-cancel").addEventListener("click", cancelRecord);
    $("detail-form").addEventListener("submit", saveDetail);
    $("detail-reset").addEventListener("click", function () {
      resetDetailForm();
      renderDetails();
    });
    var logout = $("logout-button");
    if (logout && window.LapinaAuth) {
      logout.addEventListener("click", function () {
        logout.disabled = true;
        window.LapinaAuth.signOut();
      });
    }
    syncLocationField();
    syncBodyField();
    setRecordMode("draft");
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
      pageMessage(error && error.message ? error.message : "施術管理を開けませんでした。");
    });
  });
})();
