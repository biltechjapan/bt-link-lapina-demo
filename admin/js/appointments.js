(function () {
  "use strict";

  /*
   * auth.js は変更しない。同じ公開URLと publishable キーで、
   * ログイン済みセッションを共有するクライアントを作る。
   * service_role キーは使わない。
   */
  var SUPABASE_URL = "https://imhfdvscwsaizqvnnztl.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_f9VbCQbX_nMvzEmL1U9oZw_proWYzIl";

  var PLACE = { clinic: "店舗", visit: "訪問" };
  var TREATMENT = {
    massage: "マッサージ",
    acupuncture: "鍼",
    moxibustion: "灸",
    combined: "併用",
    other: "その他"
  };
  var PAYMENT = { insurance: "保険", private: "自費" };
  var STATUS = { scheduled: "予約", completed: "完了", cancelled: "キャンセル" };

  var client = null;
  var patients = [];
  var locations = [];
  var appointments = [];
  var monthAppointments = [];
  var visibleMonth = { year: 0, month: 0 };
  var monthRequest = 0;
  var locationRequest = 0;
  var occurrenceByAppointment = {};
  var monthKinds = {};
  var dayBlocks = [];
  var monthBlockCounts = {};

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function label(map, value) {
    return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value || "";
  }

  function seriesLabel(appointmentId) {
    var kind = occurrenceByAppointment[appointmentId];
    if (!kind) return "";
    if (kind === "one_off_edit" || kind === "one_off_cancel") return "この日だけ";
    return "定期";
  }

  function daySeriesText(dateKey) {
    var kinds = monthKinds[dateKey] || [];
    var regular = false;
    var once = false;
    for (var i = 0; i < kinds.length; i += 1) {
      if (kinds[i] === "one_off_edit" || kinds[i] === "one_off_cancel") once = true;
      else regular = true;
    }
    if (regular && once) return "定期・この日だけ";
    if (once) return "この日だけ";
    if (regular) return "定期";
    return "";
  }

  function rememberOccurrence(row) {
    if (!row || !row.appointment_id || !row.kind) return;
    occurrenceByAppointment[row.appointment_id] = row.kind;
  }

  function loadOccurrenceRows(ids) {
    var unique = [];
    var seen = {};
    for (var i = 0; i < ids.length; i += 1) {
      if (!ids[i] || seen[ids[i]]) continue;
      seen[ids[i]] = true;
      unique.push(ids[i]);
    }
    if (!unique.length) return Promise.resolve([]);
    return getClient()
      .from("visit_series_occurrences")
      .select("appointment_id, occurrence_date, kind")
      .in("appointment_id", unique)
      .then(function (result) {
        if (result.error) return [];
        (result.data || []).forEach(rememberOccurrence);
        return result.data || [];
      });
  }

  function japanDateKey(date) {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    var bag = {};
    parts.forEach(function (part) {
      bag[part.type] = part.value;
    });
    return bag.year + "-" + bag.month + "-" + bag.day;
  }

  function two(value) {
    var text = String(value || "");
    if (text === "24") return "00";
    return text.length === 1 ? "0" + text : text;
  }

  function japanClock(iso) {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(iso));
    var bag = {};
    parts.forEach(function (part) {
      bag[part.type] = part.value;
    });
    return two(bag.hour) + ":" + two(bag.minute);
  }

  function inputFromTimestamptz(iso) {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(iso));
    var bag = {};
    parts.forEach(function (part) {
      bag[part.type] = part.value;
    });
    return bag.year + "-" + two(bag.month) + "-" + two(bag.day) + "T" + two(bag.hour) + ":" + two(bag.minute);
  }

  function isoFromJapanInput(value) {
    var text = trim(value);
    if (!text) return "";
    if (text.length === 16) text += ":00";
    return text + "+09:00";
  }

  function nextJapanDay(dateKey) {
    var start = new Date(dateKey + "T00:00:00+09:00");
    return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }

  function japanWeekday(dateKey) {
    var name = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      weekday: "short"
    }).format(new Date(dateKey + "T12:00:00+09:00"));
    var names = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return names[name];
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function shiftMonth(year, month, delta) {
    var index = year * 12 + (month - 1) + delta;
    var nextYear = Math.floor(index / 12);
    var nextMonth = index - nextYear * 12;
    return { year: nextYear, month: nextMonth + 1 };
  }

  function monthKey(year, month) {
    return year + "-" + two(month);
  }

  function pageMessage(message) {
    var slot = $("page-message");
    if (slot) slot.textContent = message || "";
  }

  function formMessage(message) {
    var slot = $("form-message");
    if (!slot) return;
    slot.textContent = message || "";
    slot.classList.remove("appt-overlap-warning");
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

  function patientById(id) {
    for (var i = 0; i < patients.length; i += 1) {
      if (patients[i].id === id) return patients[i];
    }
    return null;
  }

  function patientLabel(patient) {
    if (!patient) return "患者情報なし";
    var parts = [];
    if (patient.patient_no) parts.push(String(patient.patient_no));
    if (patient.last_name) parts.push(String(patient.last_name));
    if (patient.first_name) parts.push(String(patient.first_name));
    return parts.length ? parts.join(" ") : "患者情報なし";
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
    var select = $("patient-location-id");
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
    var isVisit = $("location-type").value === "visit";
    $("location-field").hidden = !isVisit;
    $("patient-location-id").required = isVisit;
    if (!isVisit) $("patient-location-id").value = "";
  }

  function renderList() {
    var list = $("appointment-list");
    var selected = $("appointment-form").getAttribute("data-id") || "";
    list.innerHTML = "";
    if (!appointments.length) {
      var empty = document.createElement("p");
      empty.className = "appt-empty";
      empty.textContent = "この日の予約はありません。";
      list.appendChild(empty);
      return;
    }
    appointments.forEach(function (row) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "appt-item";
      if (row.id === selected) button.classList.add("is-selected");
      if (row.status === "scheduled") button.classList.add("is-scheduled");
      if (row.status === "completed") button.classList.add("is-completed");
      if (row.status === "cancelled") button.classList.add("is-cancelled");

      var time = document.createElement("span");
      time.className = "appt-time";
      time.textContent = japanClock(row.start_at) + "–" + japanClock(row.end_at);

      var patient = document.createElement("span");
      patient.className = "appt-patient";
      patient.textContent = patientLabel(patientById(row.patient_id));

      var meta = document.createElement("span");
      meta.className = "appt-meta";
      var statusLabel = label(STATUS, row.status);
      meta.appendChild(document.createTextNode([
        label(PLACE, row.visit_type),
        seriesLabel(row.id),
        label(TREATMENT, row.treatment_type),
        label(PAYMENT, row.payment_type)
      ].filter(function (part) { return part; }).join(" / ") + " / "));
      if (row.status === "cancelled") {
        var status = document.createElement("span");
        status.className = "appt-status-cancelled";
        status.textContent = statusLabel;
        meta.appendChild(status);
      } else {
        meta.appendChild(document.createTextNode(statusLabel));
      }

      button.appendChild(time);
      button.appendChild(patient);
      button.appendChild(meta);
      button.addEventListener("click", function () {
        fillForm(row);
      });
      list.appendChild(button);
    });
  }

  function clearForm() {
    var form = $("appointment-form");
    form.removeAttribute("data-id");
    form.reset();
    $("status").value = "scheduled";
    $("location-type").value = "clinic";
    locations = [];
    fillLocations("");
    syncLocationField();
    $("cancel-button").hidden = true;
    $("form-title").textContent = "予約の登録";
    formMessage("");
    renderList();
  }

  function fillForm(row) {
    var form = $("appointment-form");
    form.setAttribute("data-id", row.id);
    $("patient-id").value = row.patient_id || "";
    $("start-at").value = inputFromTimestamptz(row.start_at);
    $("end-at").value = inputFromTimestamptz(row.end_at);
    $("location-type").value = row.visit_type || "clinic";
    $("treatment-type").value = row.treatment_type || "";
    $("payment-type").value = row.payment_type || "";
    $("status").value = row.status || "scheduled";
    $("title").value = row.title || "";
    $("notes").value = row.notes || "";
    $("cancel-button").hidden = row.status === "cancelled";
    $("form-title").textContent = "予約の編集";
    formMessage("");
    syncLocationField();
    loadLocations(row.patient_id, row.location_id);
    renderList();
  }

  function loadPatients() {
    return getClient()
      .from("patients")
      .select("id, patient_no, last_name, first_name")
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
    if (!patientId || $("location-type").value !== "visit") return Promise.resolve();
    return getClient()
      .from("patient_locations")
      .select("id, patient_id, location_name")
      .eq("patient_id", patientId)
      .order("location_name", { ascending: true })
      .then(function (result) {
        if (requestId !== locationRequest) return;
        if (result.error) throw result.error;
        locations = result.data || [];
        fillLocations(selectedId || "");
      });
  }

  function syncVisibleMonth(dateKey) {
    var parts = String(dateKey || "").split("-");
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    if (!year || !month) return;
    if (visibleMonth.year !== year || visibleMonth.month !== month) monthAppointments = [];
    visibleMonth = { year: year, month: month };
  }

  function dayCounts(dateKey) {
    var counts = { scheduled: 0, completed: 0, cancelled: 0, clinic: 0, visit: 0 };
    monthAppointments.forEach(function (row) {
      if (japanDateKey(new Date(row.start_at)) !== dateKey) return;
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] += 1;
      if (row.visit_type === "clinic" || row.visit_type === "visit") counts[row.visit_type] += 1;
    });
    return counts;
  }

  function appendCount(parent, className, text) {
    var mark = document.createElement("span");
    mark.className = className;
    mark.textContent = text;
    parent.appendChild(mark);
  }

  function renderCalendar() {
    var grid = $("cal-grid");
    if (!grid || !visibleMonth.year) return;
    var year = visibleMonth.year;
    var month = visibleMonth.month;
    var selected = $("appointment-date").value || "";
    var today = japanDateKey(new Date());
    $("cal-title").textContent = year + "年" + month + "月";
    grid.innerHTML = "";
    ["日", "月", "火", "水", "木", "金", "土"].forEach(function (name) {
      var head = document.createElement("div");
      head.className = "appt-cal-weekday";
      head.textContent = name;
      grid.appendChild(head);
    });
    var firstKey = monthKey(year, month) + "-01";
    var leading = japanWeekday(firstKey);
    var total = daysInMonth(year, month);
    var i;
    for (i = 0; i < leading; i += 1) {
      var blank = document.createElement("div");
      blank.className = "appt-day is-blank";
      blank.setAttribute("aria-hidden", "true");
      grid.appendChild(blank);
    }
    for (i = 1; i <= total; i += 1) {
      var dateKey = monthKey(year, month) + "-" + two(i);
      var counts = dayCounts(dateKey);
      var button = document.createElement("button");
      button.type = "button";
      button.className = "appt-day";
      if (dateKey === selected) button.classList.add("is-selected");
      if (dateKey === today) button.classList.add("is-today");
      button.setAttribute("aria-pressed", dateKey === selected ? "true" : "false");
      button.setAttribute("aria-label", month + "月" + i + "日の予約を表示");
      var number = document.createElement("span");
      number.className = "appt-day-num";
      number.textContent = String(i);
      button.appendChild(number);
      if (counts.scheduled) appendCount(button, "appt-day-mark is-scheduled", "予約" + counts.scheduled);
      if (counts.completed) appendCount(button, "appt-day-mark is-completed", "完了" + counts.completed);
      if (counts.cancelled) appendCount(button, "appt-day-mark is-cancelled", "キャンセル" + counts.cancelled);
      if (counts.clinic || counts.visit) {
        var place = document.createElement("span");
        place.className = "appt-day-place";
        var placeText = [];
        if (counts.clinic) placeText.push("店舗" + counts.clinic);
        if (counts.visit) placeText.push("訪問" + counts.visit);
        var seriesText = daySeriesText(dateKey);
        if (seriesText) placeText.push(seriesText);
        place.textContent = placeText.join(" ");
        button.appendChild(place);
      }
      if (monthBlockCounts[dateKey]) appendCount(button, "appt-day-mark is-block", "ブロック" + monthBlockCounts[dateKey]);
      button.addEventListener("click", function (key) {
        return function () {
          $("appointment-date").value = key;
          pageMessage("");
          loadAppointments().catch(function (error) {
            pageMessage(error && error.message ? error.message : "予約を読み込めませんでした。");
          });
        };
      }(dateKey));
      grid.appendChild(button);
    }
  }

  function loadMonth() {
    if (!visibleMonth.year) return Promise.resolve();
    var requestId = monthRequest + 1;
    monthRequest = requestId;
    var start = monthKey(visibleMonth.year, visibleMonth.month) + "-01T00:00:00+09:00";
    var next = shiftMonth(visibleMonth.year, visibleMonth.month, 1);
    var end = monthKey(next.year, next.month) + "-01T00:00:00+09:00";
    return getClient()
      .from("appointments")
      .select("id, start_at, visit_type, status")
      .gte("start_at", start)
      .lt("start_at", end)
      .then(function (result) {
        if (requestId !== monthRequest) return;
        if (result.error) throw result.error;
        monthAppointments = result.data || [];
        var ids = [];
        for (var i = 0; i < monthAppointments.length; i += 1) ids.push(monthAppointments[i].id);
        return loadOccurrenceRows(ids).then(function (rows) {
          if (requestId !== monthRequest) return;
          monthKinds = {};
          for (var j = 0; j < rows.length; j += 1) {
            var row = rows[j];
            if (!row || !row.occurrence_date || !row.kind) continue;
            if (!monthKinds[row.occurrence_date]) monthKinds[row.occurrence_date] = [];
            monthKinds[row.occurrence_date].push(row.kind);
          }
          renderCalendar();
          return loadMonthBlocks(start, end, requestId);
        });
      });
  }

  function moveMonth(delta) {
    visibleMonth = shiftMonth(visibleMonth.year, visibleMonth.month, delta);
    monthAppointments = [];
    renderCalendar();
    loadMonth().catch(function (error) {
      pageMessage(error && error.message ? error.message : "月間の予約を読み込めませんでした。");
    });
  }

  function loadAppointments() {
    var dateKey = $("appointment-date").value || japanDateKey(new Date());
    $("appointment-date").value = dateKey;
    syncVisibleMonth(dateKey);
    var monthPromise = loadMonth();
    var start = dateKey + "T00:00:00+09:00";
    var end = nextJapanDay(dateKey);
    return getClient()
      .from("appointments")
      .select("id, patient_id, location_id, start_at, end_at, visit_type, treatment_type, payment_type, status, title, notes")
      .gte("start_at", start)
      .lt("start_at", end)
      .order("start_at", { ascending: true })
      .then(function (result) {
        if (result.error) throw result.error;
        appointments = result.data || [];
        var ids = [];
        for (var i = 0; i < appointments.length; i += 1) ids.push(appointments[i].id);
        return loadOccurrenceRows(ids).then(function () {
          renderList();
          return loadDayBlocks(dateKey).then(function () {
            return monthPromise;
          });
        });
      });
  }

  function findOverlap(startIso, endIso, currentId) {
    return getClient()
      .from("appointments")
      .select("id, start_at, end_at, status")
      .lt("start_at", endIso)
      .gt("end_at", startIso)
      .neq("status", "cancelled")
      .then(function (result) {
        if (result.error) throw result.error;
        var rows = result.data || [];
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].id !== currentId) return rows[i];
        }
        return null;
      });
  }

  function payloadFromForm() {
    var place = $("location-type").value;
    var startIso = isoFromJapanInput($("start-at").value);
    var endIso = isoFromJapanInput($("end-at").value);
    var start = new Date(startIso);
    var end = new Date(endIso);
    if (!startIso || !endIso || isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      return { error: "終了日時は開始日時より後にしてください。" };
    }
    if (!$("patient-id").value) return { error: "患者を選択してください。" };
    if (place === "visit" && !$("patient-location-id").value) {
      return { error: "訪問の場合は、その患者の訪問先を選択してください。" };
    }
    return {
      startIso: startIso,
      endIso: endIso,
      values: {
        patient_id: $("patient-id").value,
        location_id: place === "visit" ? $("patient-location-id").value : null,
        start_at: startIso,
        end_at: endIso,
        visit_type: place,
        treatment_type: $("treatment-type").value,
        payment_type: $("payment-type").value,
        status: $("status").value,
        title: trim($("title").value) || null,
        notes: trim($("notes").value) || null
      }
    };
  }

  function currentAppointment() {
    var id = $("appointment-form").getAttribute("data-id");
    if (!id) return null;
    for (var i = 0; i < appointments.length; i += 1) {
      if (appointments[i].id === id) return appointments[i];
    }
    return null;
  }

  function seriesActionError(error, fallback) {
    var raw = error && error.message ? String(error.message) : "";
    if (raw.indexOf("完了済みの予約は変更しません") !== -1) return "完了済みの定期訪問は変更しません。";
    if (raw.indexOf("この日はキャンセル済みです") !== -1) return "この日はキャンセル済みです。自動では作り直しません。";
    if (raw.indexOf("この操作を行う権限がありません") !== -1) return "この操作を行う権限がありません。";
    return fallback;
  }

  function saveForm(event) {
    event.preventDefault();
    var form = $("appointment-form");
    var currentId = form.getAttribute("data-id") || "";
    var built = payloadFromForm();
    if (built.error) {
      formMessage(built.error);
      return;
    }
    var existing = currentAppointment();
    var kind = currentId ? occurrenceByAppointment[currentId] || "" : "";
    if (existing && existing.status === "completed" && kind) {
      formMessage("完了済みの定期訪問は変更しません。");
      return;
    }
    if (kind && kind !== "one_off_cancel" && built.values.status === "cancelled") {
      if (!window.confirm("この日だけキャンセルします。定期のほかの日は残ります。予約データは削除しません。")) return;
    }
    var submit = form.querySelector("[type='submit']");
    if (submit) submit.disabled = true;
    formMessage("");
    findOverlap(built.startIso, built.endIso, currentId).then(function (overlap) {
      if (overlap && built.values.status !== "cancelled") {
        formMessage("この時間には別の予約があります。保存していません。");
        $("form-message").classList.add("appt-overlap-warning");
        return null;
      }
      if (built.values.status === "cancelled") return saveAppointment(currentId, built.values);
      return findActiveBlock(built.startIso, built.endIso, "").then(function (blocked) {
        if (blocked) {
          formMessage("この時間はブロックされています。保存していません。");
          return null;
        }
        return saveAppointment(currentId, built.values);
      });
    }).then(function (result) {
      if (!result) return null;
      if (result.error) throw result.error;
      if (!currentId || !kind || kind === "one_off_cancel") return result;
      if (built.values.status === "cancelled") {
        return getClient().rpc("cancel_visit_occurrence", { p_appointment_id: currentId }).then(function (marked) {
          if (marked.error) throw marked.error;
          return result;
        });
      }
      if (built.values.status === "scheduled" && (kind === "generated" || kind === "paused" || kind === "one_off_edit")) {
        return getClient().rpc("mark_visit_occurrence_edited", { p_appointment_id: currentId }).then(function (marked) {
          if (marked.error) throw marked.error;
          return result;
        });
      }
      return result;
    }).then(function (result) {
      if (!result) return null;
      if (result.error) throw result.error;
      pageMessage(currentId ? "予約を更新しました。" : "予約を登録しました。");
      $("appointment-date").value = japanDateKey(new Date(built.startIso));
      clearForm();
      return loadAppointments();
    }).catch(function (error) {
      formMessage(seriesActionError(error, error && error.message ? error.message : "保存できませんでした。"));
    }).then(function () {
      if (submit) submit.disabled = false;
    });
  }

  function cancelAppointment() {
    var id = $("appointment-form").getAttribute("data-id");
    if (!id) return;
    var existing = currentAppointment();
    var kind = occurrenceByAppointment[id] || "";
    if (existing && existing.status === "completed" && kind) {
      formMessage("完了済みの定期訪問は変更しません。");
      return;
    }
    var seriesCancel = kind && kind !== "one_off_cancel";
    var message = seriesCancel
      ? "この日だけキャンセルします。定期のほかの日は残ります。予約データは削除しません。"
      : "この予約をキャンセルしますか？予約データは削除しません。";
    if (!window.confirm(message)) return;
    var button = $("cancel-button");
    button.disabled = true;
    var request = seriesCancel
      ? getClient().rpc("cancel_visit_occurrence", { p_appointment_id: id })
      : getClient().from("appointments").update({ status: "cancelled" }).eq("id", id).select("id").single();
    request
      .then(function (result) {
        if (result.error) throw result.error;
        pageMessage(seriesCancel ? "この日だけキャンセルしました。" : "予約をキャンセルしました。");
        clearForm();
        return loadAppointments();
      })
      .catch(function (error) {
        formMessage(seriesActionError(error, error && error.message ? error.message : "キャンセルできませんでした。"));
      })
      .then(function () {
        button.disabled = false;
      });
  }

  function saveAppointment(currentId, values) {
    var query = getClient().from("appointments");
    if (currentId) return query.update(values).eq("id", currentId).select("id").single();
    return query.insert(values).select("id").single();
  }

  function blockMessage(message) {
    var slot = $("block-message");
    if (slot) slot.textContent = message || "";
  }

  function blockError(error, fallback) {
    var raw = error && error.message ? String(error.message) : "";
    var known = [
      "この操作を行う権限がありません",
      "日付、時刻、理由を確認してください。",
      "時間を確認してください。",
      "この時間には別の予約があります。保存していません。",
      "この時間はブロックされています。保存していません。",
      "時間ブロックが見つかりません。",
      "時間ブロックを指定してください。",
      "解除済みの時間ブロックは変更しません。"
    ];
    for (var i = 0; i < known.length; i += 1) {
      if (raw.indexOf(known[i]) !== -1) return known[i];
    }
    if (error && (error.code === "PGRST202" || /could not find the function|schema cache/i.test(raw))) {
      return "時間ブロックはまだ有効ではありません。";
    }
    return fallback;
  }

  function rememberBlockDays(rows) {
    var counts = {};
    (rows || []).forEach(function (block) {
      if (!block || block.status !== "active") return;
      var cursor = japanDateKey(new Date(block.starts_at));
      var endKey = japanDateKey(new Date(new Date(block.ends_at).getTime() - 1));
      var guard = 0;
      while (cursor <= endKey && guard < 40) {
        counts[cursor] = (counts[cursor] || 0) + 1;
        cursor = japanDateKey(new Date(new Date(cursor + "T12:00:00+09:00").getTime() + 24 * 60 * 60 * 1000));
        guard += 1;
      }
    });
    return counts;
  }

  function loadMonthBlocks(start, end, requestId) {
    return getClient()
      .from("time_blocks")
      .select("id, starts_at, ends_at, status")
      .eq("status", "active")
      .lt("starts_at", end)
      .gt("ends_at", start)
      .then(function (result) {
        if (requestId !== monthRequest) return;
        monthBlockCounts = result.error ? {} : rememberBlockDays(result.data || []);
        renderCalendar();
      });
  }

  function renderBlocks() {
    var list = $("block-list");
    if (!list) return;
    var selected = $("block-form") ? $("block-form").getAttribute("data-id") || "" : "";
    list.innerHTML = "";
    if (!dayBlocks.length) {
      var empty = document.createElement("p");
      empty.className = "appt-empty";
      empty.textContent = "この日の時間ブロックはありません。";
      list.appendChild(empty);
      return;
    }
    dayBlocks.forEach(function (row) {
      var item = document.createElement("article");
      item.className = "appt-item is-block" + (row.status === "released" ? " is-released" : "");
      var time = document.createElement("span");
      time.className = "appt-time";
      time.textContent = japanClock(row.starts_at) + "–" + japanClock(row.ends_at);
      var title = document.createElement("span");
      title.className = "appt-patient";
      title.textContent = row.reason ? String(row.reason) : "理由未設定";
      var meta = document.createElement("span");
      meta.className = "appt-meta";
      meta.textContent = row.status === "released" ? "解除済み" : "予約不可";
      item.appendChild(time);
      item.appendChild(title);
      item.appendChild(meta);
      if (row.status === "active") {
        var edit = document.createElement("button");
        edit.type = "button";
        edit.className = "button-quiet block-edit";
        edit.setAttribute("data-id", row.id);
        edit.textContent = "編集";
        var release = document.createElement("button");
        release.type = "button";
        release.className = "button-quiet block-release";
        release.setAttribute("data-id", row.id);
        release.textContent = "解除";
        item.appendChild(edit);
        item.appendChild(release);
      }
      if (row.id === selected) item.classList.add("is-selected");
      list.appendChild(item);
    });
  }

  function loadDayBlocks(dateKey) {
    var start = dateKey + "T00:00:00+09:00";
    var end = nextJapanDay(dateKey);
    return getClient()
      .from("time_blocks")
      .select("id, starts_at, ends_at, reason, status")
      .lt("starts_at", end)
      .gt("ends_at", start)
      .order("starts_at", { ascending: true })
      .then(function (result) {
        if (result.error) {
          dayBlocks = [];
          renderBlocks();
          blockMessage("時間ブロックはまだ有効ではありません。");
          return;
        }
        dayBlocks = result.data || [];
        renderBlocks();
      });
  }

  function findActiveBlock(startIso, endIso, currentId) {
    return getClient()
      .from("time_blocks")
      .select("id")
      .eq("status", "active")
      .lt("starts_at", endIso)
      .gt("ends_at", startIso)
      .then(function (result) {
        if (result.error) return null;
        var rows = result.data || [];
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].id !== currentId) return rows[i];
        }
        return null;
      });
  }

  function clearBlockForm() {
    var form = $("block-form");
    if (!form) return;
    form.removeAttribute("data-id");
    form.reset();
    $("block-save").textContent = "時間ブロックを登録";
    blockMessage("");
    renderBlocks();
  }

  function blockRange() {
    var dateKey = $("appointment-date").value;
    var start = trim($("block-start").value).slice(0, 5);
    var end = trim($("block-end").value).slice(0, 5);
    var reason = trim($("block-reason").value);
    if (!dateKey || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      return { error: "日付、時刻、理由を確認してください。" };
    }
    if (end <= start) return { error: "終了時刻は開始時刻より後にしてください。" };
    if (!reason || reason.length > 200) return { error: "日付、時刻、理由を確認してください。" };
    return {
      starts: dateKey + "T" + start + ":00+09:00",
      ends: dateKey + "T" + end + ":00+09:00",
      reason: reason
    };
  }

  function saveBlock(event) {
    event.preventDefault();
    var built = blockRange();
    if (built.error) {
      blockMessage(built.error);
      return;
    }
    var id = $("block-form").getAttribute("data-id") || "";
    var button = $("block-save");
    button.disabled = true;
    blockMessage("");
    var request = id
      ? getClient().rpc("update_time_block", {
        p_id: id,
        p_starts_at: built.starts,
        p_ends_at: built.ends,
        p_reason: built.reason
      })
      : getClient().rpc("create_time_block", {
        p_starts_at: built.starts,
        p_ends_at: built.ends,
        p_reason: built.reason
      });
    request.then(function (result) {
      if (result.error) throw result.error;
      pageMessage(id ? "時間ブロックを更新しました。" : "時間ブロックを登録しました。");
      clearBlockForm();
      return loadAppointments();
    }).catch(function (error) {
      blockMessage(blockError(error, "時間ブロックを保存できませんでした。"));
    }).then(function () {
      button.disabled = false;
    });
  }

  function releaseBlock(id) {
    if (!id) return;
    if (!window.confirm("この時間ブロックを解除しますか？履歴は残します。予約は作りません。")) return;
    blockMessage("");
    getClient().rpc("release_time_block", { p_id: id }).then(function (result) {
      if (result.error) throw result.error;
      pageMessage("時間ブロックを解除しました。履歴は残しています。");
      clearBlockForm();
      return loadAppointments();
    }).catch(function (error) {
      blockMessage(blockError(error, "時間ブロックを解除できませんでした。"));
    });
  }

  function editBlock(id) {
    var row = null;
    for (var i = 0; i < dayBlocks.length; i += 1) {
      if (dayBlocks[i].id === id) row = dayBlocks[i];
    }
    if (!row || row.status !== "active") return;
    $("block-form").setAttribute("data-id", row.id);
    $("block-start").value = japanClock(row.starts_at);
    $("block-end").value = japanClock(row.ends_at);
    $("block-reason").value = row.reason || "";
    $("block-save").textContent = "時間ブロックを更新";
    blockMessage("");
    renderBlocks();
    $("block-start").focus();
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
    $("appointment-date").value = japanDateKey(new Date());
  }

  function bindUi() {
    $("appointment-date").addEventListener("change", function () {
      pageMessage("");
      loadAppointments().catch(function (error) {
        pageMessage(error && error.message ? error.message : "予約を読み込めませんでした。");
      });
    });
    $("patient-id").addEventListener("change", function () {
      loadLocations($("patient-id").value, "").catch(function (error) {
        formMessage(error && error.message ? error.message : "訪問先を読み込めませんでした。");
      });
    });
    $("location-type").addEventListener("change", function () {
      syncLocationField();
      if ($("location-type").value === "visit") {
        loadLocations($("patient-id").value, "").catch(function (error) {
          formMessage(error && error.message ? error.message : "訪問先を読み込めませんでした。");
        });
      }
    });
    $("appointment-form").addEventListener("submit", saveForm);
    $("reset-button").addEventListener("click", function () {
      pageMessage("");
      clearForm();
    });
    $("cancel-button").addEventListener("click", cancelAppointment);
    $("block-form").addEventListener("submit", saveBlock);
    $("block-reset").addEventListener("click", clearBlockForm);
    $("block-list").addEventListener("click", function (event) {
      var edit = event.target.closest(".block-edit");
      var release = event.target.closest(".block-release");
      if (edit) editBlock(edit.getAttribute("data-id"));
      if (release) releaseBlock(release.getAttribute("data-id"));
    });
    $("cal-prev").addEventListener("click", function () {
      moveMonth(-1);
    });
    $("cal-next").addEventListener("click", function () {
      moveMonth(1);
    });
    syncLocationField();
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindUi();
    if (!window.LapinaAuth) return;
    window.LapinaAuth.requireAdmin().then(function (session) {
      if (!session) return;
      var supabaseClient;
      try {
        supabaseClient = getClient();
      } catch (error) {
        pageMessage(error.message);
        return null;
      }
      client = supabaseClient;
      showApp(session.user);
      return loadPatients().then(loadAppointments);
    }).catch(function (error) {
      pageMessage(error && error.message ? error.message : "予約管理を開けませんでした。");
    });
  });
})();
