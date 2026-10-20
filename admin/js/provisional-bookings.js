(function () {
  "use strict";

  var STATUS = {
    pending: "確認待ち",
    approved: "承認済み",
    declined: "見送り",
    expired: "期限切れ"
  };
  var TREATMENT = {
    massage: "マッサージ",
    acupuncture: "鍼",
    moxibustion: "灸",
    combined: "併用",
    other: "その他"
  };
  var PAYMENT = { insurance: "保険", private: "自費" };
  var APPOINTMENT_STATUS = {
    scheduled: "予約",
    completed: "完了",
    cancelled: "キャンセル",
    no_show: "未来店"
  };
  var WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
  var BOOKING_COLUMNS = [
    "id",
    "public_reference",
    "reception_code",
    "store_id",
    "status",
    "course_name",
    "duration_minutes",
    "price_yen",
    "start_at",
    "end_at",
    "visit_type",
    "last_name",
    "first_name",
    "last_name_kana",
    "first_name_kana",
    "phone",
    "phone_digits",
    "email",
    "customer_note",
    "hold_until",
    "patient_id",
    "appointment_id",
    "decline_reason",
    "reviewed_at",
    "created_at"
  ].join(", ");

  var bookings = [];
  var stores = [];
  var patients = [];
  var dayAppointments = [];
  var filterStatus = "pending";
  var selectedId = null;
  var selectedPatientId = null;
  var confirmMode = "";
  var busy = false;
  var listRequest = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value || "").replace(/^\s+|\s+$/g, "");
  }

  function digits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function client() {
    return window.LapinaAuth.getClient();
  }

  function pageMessage(message, warning) {
    var slot = $("page-message");
    slot.textContent = message || "";
    slot.classList.toggle("appt-overlap-warning", warning === true);
  }

  function detailMessage(message, warning) {
    var slot = $("detail-message");
    slot.textContent = message || "";
    slot.classList.toggle("appt-overlap-warning", warning === true);
  }

  function publicMessage(error) {
    var raw = error && error.message ? String(error.message) : "";
    var known = [
      "この操作を行う権限がありません",
      "施術区分を選択してください。",
      "支払区分を選択してください。",
      "既存の患者か、新しい患者番号のどちらか一方を指定してください。",
      "この仮予約は見つかりません",
      "予約の状態が変わったため、最初からやり直してください。",
      "この仮予約は承認できません",
      "有効な患者を選択してください。",
      "この患者番号はすでに登録されています。",
      "この時間には別の予約があります。保存していません。",
      "見送り理由は500文字以内で入力してください。",
      "この仮予約は見送りできません"
    ];
    var index;
    for (index = 0; index < known.length; index += 1) {
      if (raw.indexOf(known[index]) !== -1) return known[index];
    }
    if (/42501|permission denied/i.test(raw)) return "この操作を行う権限がありません。";
    if (/PGRST205|schema cache|Could not find the table/i.test(raw)) {
      return "仮予約の情報を確認できません。";
    }
    return "通信できませんでした。時間をおいて、もう一度お試しください。";
  }

  function isOverlap(message) {
    return message.indexOf("この時間には別の予約があります") !== -1;
  }

  function yen(amount) {
    return Number(amount).toLocaleString("ja-JP") + "円";
  }

  function tokyoParts(iso) {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short"
    }).formatToParts(new Date(iso));
    var bag = {};
    parts.forEach(function (part) {
      bag[part.type] = part.value;
    });
    if (bag.hour === "24") bag.hour = "00";
    return bag;
  }

  function tokyoDayKey(iso) {
    var bag = tokyoParts(iso);
    return bag.year + "-" + bag.month + "-" + bag.day;
  }

  function weekdayIndex(dateKey) {
    var parts = dateKey.split("-");
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
  }

  function formatWhen(startIso, endIso) {
    var bag = tokyoParts(startIso);
    var day = Number(bag.year) + "年" + Number(bag.month) + "月" + Number(bag.day) + "日（" + WEEKDAY[weekdayIndex(tokyoDayKey(startIso))] + "）";
    var clock = bag.hour + ":" + bag.minute;
    if (!endIso) return day + " " + clock;
    var end = tokyoParts(endIso);
    return day + " " + clock + "〜" + end.hour + ":" + end.minute;
  }

  function formatStamp(iso) {
    if (!iso) return "";
    return formatWhen(iso);
  }

  function statusLabel(value) {
    return Object.prototype.hasOwnProperty.call(STATUS, value) ? STATUS[value] : value || "";
  }

  function receptionText(booking) {
    var code = trim(booking && booking.reception_code);
    if (code) return code;
    return trim(booking && booking.public_reference);
  }

  function storeText(booking) {
    var storeId = booking && booking.store_id;
    var index;
    var name;
    if (!storeId) return "店舗未設定";
    for (index = 0; index < stores.length; index += 1) {
      if (stores[index].id !== storeId) continue;
      name = trim(stores[index].name);
      return name || "店舗未設定";
    }
    return "店舗未設定";
  }

  function selectedBooking() {
    var index;
    for (index = 0; index < bookings.length; index += 1) {
      if (bookings[index].id === selectedId) return bookings[index];
    }
    return null;
  }

  function patientById(id) {
    var index;
    for (index = 0; index < patients.length; index += 1) {
      if (patients[index].id === id) return patients[index];
    }
    return null;
  }

  function selectedPatient() {
    return patientById(selectedPatientId);
  }

  function instant(value) {
    var time = new Date(value).getTime();
    return isNaN(time) ? null : time;
  }

  function isLapsed(booking) {
    if (!booking || booking.status !== "pending") return false;
    var now = Date.now();
    var hold = instant(booking.hold_until);
    var start = instant(booking.start_at);
    if (hold === null || start === null) return false;
    return hold <= now || start <= now;
  }

  function screenStatus(booking) {
    if (!booking) return "";
    if (booking.status !== "pending") return booking.status;
    return isLapsed(booking) ? "expired" : "pending";
  }

  function canApprove(booking) {
    if (!booking || booking.status !== "pending" || isLapsed(booking)) return false;
    var now = Date.now();
    var hold = instant(booking.hold_until);
    var start = instant(booking.start_at);
    return hold !== null && start !== null && hold > now && start > now;
  }

  function patientMode() {
    var chosen = document.querySelector("input[name='patient-mode']:checked");
    return chosen ? chosen.value : "existing";
  }

  function fullName(row) {
    return trim(row.last_name) + " " + trim(row.first_name);
  }

  function fullKana(row) {
    return trim(row.last_name_kana) + " " + trim(row.first_name_kana);
  }

  function differences(booking, patient) {
    var items = [];
    var bookingDigits = booking.phone_digits || digits(booking.phone);
    var patientDigits = [digits(patient.phone), digits(patient.mobile_phone)].filter(function (value) {
      return value !== "";
    });
    if (patientDigits.indexOf(bookingDigits) === -1) items.push("電話番号");
    if (trim(booking.last_name) !== trim(patient.last_name) || trim(booking.first_name) !== trim(patient.first_name)) {
      items.push("氏名");
    }
    if (trim(booking.last_name_kana) !== trim(patient.last_name_kana) || trim(booking.first_name_kana) !== trim(patient.first_name_kana)) {
      items.push("ふりがな");
    }
    if (trim(booking.email).toLowerCase() !== trim(patient.email).toLowerCase()) items.push("メール");
    return items;
  }

  function addFact(list, label, value) {
    var wrap = document.createElement("div");
    var term = document.createElement("dt");
    var detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value || "なし";
    wrap.appendChild(term);
    wrap.appendChild(detail);
    list.appendChild(wrap);
  }

  function setBusy(next) {
    busy = next === true;
    ["approve-review", "decline-review", "confirm-back", "confirm-run", "reload-button"].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = busy;
    });
    var run = $("confirm-run");
    if (run) {
      if (busy) run.setAttribute("aria-busy", "true");
      else run.removeAttribute("aria-busy");
    }
  }

  function visibleBookings() {
    return bookings.filter(function (booking) {
      if (filterStatus === "all") return true;
      return screenStatus(booking) === filterStatus;
    });
  }

  function paintFilters() {
    var buttons = document.querySelectorAll(".provisional-filters [data-status]");
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-status") === filterStatus ? "true" : "false");
    });
  }

  function paintList() {
    var list = $("booking-list");
    var rows = visibleBookings();
    list.replaceChildren();
    if (!rows.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = "表示できる仮予約はありません。";
      list.appendChild(empty);
      return;
    }
    rows.forEach(function (booking) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "patient-item";
      button.setAttribute("data-id", booking.id);
      button.setAttribute("aria-pressed", booking.id === selectedId ? "true" : "false");
      if (booking.id === selectedId) button.classList.add("is-selected");
      var main = document.createElement("span");
      main.className = "patient-main";
      var reference = document.createElement("span");
      reference.className = "patient-no";
      reference.textContent = receptionText(booking);
      var name = document.createElement("span");
      name.className = "patient-name";
      name.textContent = fullName(booking);
      var meta = document.createElement("span");
      meta.className = "patient-meta";
      meta.textContent = storeText(booking) + " / " + formatWhen(booking.start_at, booking.end_at) + " / " + booking.course_name + " / " + booking.phone;
      main.appendChild(reference);
      main.appendChild(name);
      main.appendChild(meta);
      var state = document.createElement("span");
      state.className = "badge";
      state.textContent = statusLabel(screenStatus(booking));
      button.appendChild(main);
      button.appendChild(state);
      list.appendChild(button);
    });
  }

  function paintCompare(booking, patient) {
    var box = $("patient-compare");
    var label = $("identity-label");
    var checks = differences(booking, patient);
    box.hidden = false;
    box.replaceChildren();
    [booking, patient].forEach(function (row, index) {
      var article = document.createElement("article");
      var title = document.createElement("h4");
      title.textContent = index === 0 ? "仮予約" : "登録済みの患者";
      var body = document.createElement("p");
      var lines = [
        index === 0 ? "受付番号 " + receptionText(booking) : "患者番号 " + (patient.patient_no || ""),
        fullName(row),
        fullKana(row),
        row.phone || "電話番号なし",
        trim(row.email) || "メールなし"
      ];
      body.textContent = lines.join("\n");
      article.appendChild(title);
      article.appendChild(body);
      box.appendChild(article);
    });
    label.hidden = checks.length === 0;
    if (checks.length) {
      label.querySelector("span").textContent = checks.join("、") + "が違います。違いを確認しました。患者情報は変更しません。";
    }
  }

  function paintPatientResults(booking) {
    var list = $("patient-results");
    var query = trim($("patient-search").value).toLowerCase();
    var queryDigits = digits(query);
    list.replaceChildren();
    if (!query) {
      var hint = document.createElement("p");
      hint.className = "patient-empty";
      hint.textContent = "患者番号、氏名、電話番号で検索してください。";
      list.appendChild(hint);
      return;
    }
    var matches = patients.filter(function (patient) {
      if (patient.is_active !== true) return false;
      var haystack = [
        patient.patient_no,
        patient.last_name,
        patient.first_name,
        patient.last_name_kana,
        patient.first_name_kana,
        patient.phone,
        patient.mobile_phone
      ].join(" ").toLowerCase();
      if (haystack.indexOf(query) !== -1) return true;
      return queryDigits.length >= 4 && digits(haystack).indexOf(queryDigits) !== -1;
    }).slice(0, 20);
    if (!matches.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = "一致する有効な患者はいません。";
      list.appendChild(empty);
      return;
    }
    matches.forEach(function (patient) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "patient-item";
      button.setAttribute("data-patient", patient.id);
      if (patient.id === selectedPatientId) button.classList.add("is-selected");
      var main = document.createElement("span");
      main.className = "patient-main";
      var number = document.createElement("span");
      number.className = "patient-no";
      number.textContent = patient.patient_no || "";
      var name = document.createElement("span");
      name.className = "patient-name";
      name.textContent = fullName(patient);
      var meta = document.createElement("span");
      meta.className = "patient-meta";
      meta.textContent = patient.phone || patient.mobile_phone || "";
      main.appendChild(number);
      main.appendChild(name);
      main.appendChild(meta);
      button.appendChild(main);
      list.appendChild(button);
    });
    void booking;
  }

  function paintSameDay() {
    var list = $("same-day");
    list.replaceChildren();
    if (!dayAppointments.length) {
      var empty = document.createElement("p");
      empty.className = "patient-empty";
      empty.textContent = "この日の予約はありません。";
      list.appendChild(empty);
      return;
    }
    dayAppointments.forEach(function (row) {
      var item = document.createElement("article");
      item.className = "patient-item";
      var main = document.createElement("span");
      main.className = "patient-main";
      var when = document.createElement("span");
      when.className = "patient-name";
      when.textContent = formatWhen(row.start_at, row.end_at);
      var meta = document.createElement("span");
      meta.className = "patient-meta";
      var patient = patientById(row.patient_id);
      var who = patient ? patient.patient_no + " " + fullName(patient) : "患者情報なし";
      meta.textContent = who + " / " + (row.title || "件名なし") + " / " + (APPOINTMENT_STATUS[row.status] || row.status);
      main.appendChild(when);
      main.appendChild(meta);
      item.appendChild(main);
      list.appendChild(item);
    });
  }

  function paintMode() {
    var existing = patientMode() === "existing";
    $("existing-patient").hidden = !existing;
    $("new-patient").hidden = existing;
  }

  function paintDetail() {
    var booking = selectedBooking();
    var empty = $("detail-empty");
    var detail = $("detail");
    if (!booking) {
      empty.hidden = false;
      detail.hidden = true;
      return;
    }
    empty.hidden = true;
    detail.hidden = false;
    var facts = $("detail-facts");
    facts.replaceChildren();
    addFact(facts, "受付番号", receptionText(booking));
    addFact(facts, "店舗", storeText(booking));
    addFact(facts, "受付状態", statusLabel(screenStatus(booking)));
    if (booking.status === "pending" && isLapsed(booking)) {
      addFact(facts, "保存状態", "確認待ちのままです。この画面では期限切れとして表示しています。");
    }
    addFact(facts, "時刻", "このブラウザの時刻で判定しています。端末の時刻がずれていると、表示が前後します。");
    addFact(facts, "受付日時", formatStamp(booking.created_at));
    addFact(facts, "希望日時", formatWhen(booking.start_at, booking.end_at));
    addFact(facts, "コース", booking.course_name + " / " + booking.duration_minutes + "分 / " + yen(booking.price_yen));
    addFact(facts, "施術場所", "店舗");
    addFact(facts, "お名前", fullName(booking));
    addFact(facts, "ふりがな", fullKana(booking));
    addFact(facts, "電話番号", booking.phone);
    addFact(facts, "メールアドレス", trim(booking.email));
    addFact(facts, "ご要望", trim(booking.customer_note));
    addFact(facts, "確保期限", formatStamp(booking.hold_until));
    if (booking.status === "approved") {
      var patient = patientById(booking.patient_id);
      addFact(facts, "患者", patient ? patient.patient_no + " " + fullName(patient) : "予約管理に登録済み");
      addFact(facts, "予約", booking.appointment_id ? "予約管理に登録済み" : "");
    }
    if (booking.status === "declined") addFact(facts, "見送り理由", trim(booking.decline_reason));
    if (booking.reviewed_at) addFact(facts, "確認日時", formatStamp(booking.reviewed_at));
    paintSameDay();

    var pending = booking.status === "pending";
    var approvable = canApprove(booking);
    $("approve-panel").hidden = !approvable;
    $("decline-panel").hidden = !pending;
    $("action-panel").hidden = confirmMode !== "";
    $("confirm-panel").hidden = confirmMode === "";
    if (confirmMode === "" && pending && !approvable) {
      detailMessage("確保期限または開始時刻を過ぎているため、承認できません。見送りはできます。");
    }
    paintMode();
    if (selectedPatient()) paintCompare(booking, selectedPatient());
    else {
      $("patient-compare").hidden = true;
      $("identity-label").hidden = true;
    }
    if (patientMode() === "existing") paintPatientResults(booking);
  }

  function showConfirm(mode) {
    var booking = selectedBooking();
    if (!booking || busy) return;
    detailMessage("");
    if (mode === "approve") {
      var problem = approveProblem(booking);
      if (problem) {
        detailMessage(problem, isOverlap(problem));
        return;
      }
    }
    if (mode === "decline") {
      if (booking.status !== "pending") {
        detailMessage("この仮予約は見送りできません");
        return;
      }
      if (trim($("decline-reason").value).length > 500) {
        detailMessage("見送り理由は500文字以内で入力してください。");
        return;
      }
    }
    confirmMode = mode;
    var facts = $("confirm-facts");
    facts.replaceChildren();
    addFact(facts, "受付番号", receptionText(booking));
    addFact(facts, "店舗", storeText(booking));
    addFact(facts, "希望日時", formatWhen(booking.start_at, booking.end_at));
    addFact(facts, "コース", booking.course_name);
    if (mode === "approve") {
      $("confirm-title").textContent = "承認内容の確認";
      $("confirm-run").textContent = "承認する";
      if (patientMode() === "existing") {
        var patient = selectedPatient();
        addFact(facts, "患者", patient.patient_no + " " + fullName(patient));
        addFact(facts, "患者情報", "登録済みの内容は変更しません");
        var checks = differences(booking, patient);
        if (checks.length) addFact(facts, "確認した違い", checks.join("、"));
      } else {
        addFact(facts, "患者", "新規登録（登録時に自動発行）");
      }
      addFact(facts, "施術区分", TREATMENT[$("treatment-type").value]);
      addFact(facts, "支払区分", PAYMENT[$("payment-type").value]);
    } else {
      $("confirm-title").textContent = "見送り内容の確認";
      $("confirm-run").textContent = "見送る";
      addFact(facts, "見送り理由", trim($("decline-reason").value));
    }
    paintDetail();
  }

  function approveProblem(booking) {
    if (!canApprove(booking)) return "確保期限または開始時刻を過ぎているため、承認できません。";
    if (!Object.prototype.hasOwnProperty.call(TREATMENT, $("treatment-type").value)) {
      return "施術区分を選択してください。";
    }
    if (!Object.prototype.hasOwnProperty.call(PAYMENT, $("payment-type").value)) {
      return "支払区分を選択してください。";
    }
    if (patientMode() === "existing") {
      var patient = selectedPatient();
      if (!patient || patient.is_active !== true) return "有効な患者を選択してください。";
      if (differences(booking, patient).length && $("identity-confirm").checked !== true) {
        return "仮予約と患者の違いを確認してください。";
      }
      return "";
    }
    return "";
  }

  function loadSameDay(booking) {
    dayAppointments = [];
    if (!booking) return Promise.resolve();
    var day = tokyoDayKey(booking.start_at);
    var start = day + "T00:00:00+09:00";
    var end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000).toISOString();
    return client()
      .from("appointments")
      .select("id, patient_id, start_at, end_at, status, title")
      .gte("start_at", start)
      .lt("start_at", end)
      .order("start_at", { ascending: true })
      .then(function (result) {
        if (result.error) throw result.error;
        if (!selectedBooking() || selectedBooking().id !== booking.id) return;
        dayAppointments = result.data || [];
        paintSameDay();
      })
      .catch(function () {
        if (!selectedBooking() || selectedBooking().id !== booking.id) return;
        dayAppointments = [];
        var list = $("same-day");
        list.replaceChildren();
        var note = document.createElement("p");
        note.className = "patient-empty";
        note.textContent = "同じ日の予約を読み込めませんでした。";
        list.appendChild(note);
      });
  }

  function loadStores() {
    return client()
      .from("stores")
      .select("id, store_no, name")
      .order("store_no", { ascending: true })
      .then(function (result) {
        if (result.error) throw result.error;
        stores = result.data || [];
      })
      .catch(function () {
        stores = [];
      });
  }

  function loadPatients() {
    return client()
      .from("patients")
      .select("id, patient_no, last_name, first_name, last_name_kana, first_name_kana, phone, mobile_phone, email, is_active")
      .order("patient_no", { ascending: true })
      .then(function (result) {
        if (result.error) throw result.error;
        patients = result.data || [];
      });
  }

  function loadBookings() {
    var request = listRequest + 1;
    listRequest = request;
    return client()
      .from("provisional_bookings")
      .select(BOOKING_COLUMNS)
      .order("created_at", { ascending: false })
      .then(function (result) {
        if (request !== listRequest) return;
        if (result.error) throw result.error;
        bookings = result.data || [];
        if (selectedId && !selectedBooking()) selectedId = null;
        paintList();
        paintDetail();
      });
  }

  function checkAccess() {
    return Promise.all([
      client().from("provisional_bookings").select("id").limit(1),
      client().from("patients").select("id, is_active").limit(1)
    ]).then(function (results) {
      if (results[0].error) {
        var bookingError = new Error(publicMessage(results[0].error));
        bookingError.kind = "bookings";
        throw bookingError;
      }
      if (results[1].error) {
        var patientError = new Error("患者検索の権限を確認できません。");
        patientError.kind = "patients";
        throw patientError;
      }
    });
  }

  function refresh() {
    pageMessage("");
    return Promise.all([loadBookings(), loadPatients(), loadStores()]).then(function () {
      paintList();
      paintDetail();
      var booking = selectedBooking();
      if (booking) return loadSameDay(booking);
      return null;
    }).catch(function (error) {
      pageMessage(publicMessage(error));
    });
  }

  function resetChoice() {
    selectedPatientId = null;
    confirmMode = "";
    $("patient-search").value = "";
    $("treatment-type").value = "";
    $("payment-type").value = "";
    $("decline-reason").value = "";
    $("identity-confirm").checked = false;
    var existing = document.querySelector("input[name='patient-mode'][value='existing']");
    if (existing) existing.checked = true;
  }

  function runConfirm() {
    if (busy || !confirmMode) return;
    var booking = selectedBooking();
    if (!booking) return;
    if (confirmMode === "approve") {
      if (!canApprove(booking)) {
        confirmMode = "";
        detailMessage("確保期限または開始時刻を過ぎているため、承認できません。見送りはできます。");
        paintList();
        paintDetail();
        return;
      }
      var problem = approveProblem(booking);
      if (problem) {
        detailMessage(problem);
        return;
      }
      setBusy(true);
      detailMessage("");
      var existing = patientMode() === "existing";
      client()
        .rpc("approve_provisional_booking", {
          p_booking_id: booking.id,
          p_patient_id: existing ? selectedPatientId : null,
          p_patient_no: null,
          p_treatment_type: $("treatment-type").value,
          p_payment_type: $("payment-type").value
        })
        .then(function (result) {
          if (result.error) throw result.error;
          var row = Array.isArray(result.data) ? result.data[0] : result.data;
          if (!row || !row.outcome) throw new Error("通信できませんでした。時間をおいて、もう一度お試しください。");
          confirmMode = "";
          if (row.outcome === "expired") {
            resetChoice();
            detailMessage("期限切れのため承認できません。予約は作成していません。");
            return refresh();
          }
          if (row.outcome === "approved") {
            var bookingId = booking.id;
            var createdNew = !existing;
            resetChoice();
            detailMessage("承認しました。予約管理に反映しました。");
            return refresh().then(function () {
              if (!createdNew) return null;
              var saved = null;
              var index;
              for (index = 0; index < bookings.length; index += 1) {
                if (bookings[index].id === bookingId) saved = bookings[index];
              }
              var linked = saved && saved.patient_id ? patientById(saved.patient_id) : null;
              var issued = linked && linked.patient_no ? String(linked.patient_no) : "";
              if (selectedId === bookingId) paintDetail();
              if (issued) {
                detailMessage("承認しました。患者番号 " + issued + " で登録し、予約管理に反映しました。");
              }
              return null;
            });
          }
          detailMessage("承認結果を確認できませんでした。一覧を読み直してください。");
          return refresh();
        })
        .catch(function (error) {
          var message = publicMessage(error);
          detailMessage(message, isOverlap(message));
          return refresh();
        })
        .then(function () {
          setBusy(false);
        });
      return;
    }
    if (booking.status !== "pending") {
      detailMessage("この仮予約は見送りできません");
      return;
    }
    setBusy(true);
    detailMessage("");
    client()
      .rpc("decline_provisional_booking", {
        p_booking_id: booking.id,
        p_reason: trim($("decline-reason").value) || null
      })
      .then(function (result) {
        if (result.error) throw result.error;
        var value = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!value) throw new Error("この仮予約は見送りできません");
        resetChoice();
        detailMessage("見送りました。");
        return refresh();
      })
      .catch(function (error) {
        detailMessage(publicMessage(error));
        return refresh();
      })
      .then(function () {
        setBusy(false);
      });
  }

  function bind() {
    $("logout-button").addEventListener("click", function () {
      $("logout-button").disabled = true;
      window.LapinaAuth.signOut();
    });
    document.querySelector(".provisional-filters").addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button || busy) return;
      filterStatus = button.getAttribute("data-status");
      paintFilters();
      paintList();
    });
    $("reload-button").addEventListener("click", function () {
      if (busy) return;
      refresh();
    });
    $("booking-list").addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button || busy) return;
      selectedId = button.getAttribute("data-id");
      resetChoice();
      detailMessage("");
      paintList();
      paintDetail();
      var booking = selectedBooking();
      if (booking) loadSameDay(booking);
    });
    document.querySelectorAll("input[name='patient-mode']").forEach(function (input) {
      input.addEventListener("change", function () {
        if (patientMode() === "new") selectedPatientId = null;
        detailMessage("");
        paintDetail();
      });
    });
    $("patient-search").addEventListener("input", function () {
      var booking = selectedBooking();
      if (booking) paintPatientResults(booking);
    });
    $("patient-results").addEventListener("click", function (event) {
      var button = event.target.closest("button");
      if (!button || busy) return;
      selectedPatientId = button.getAttribute("data-patient");
      $("identity-confirm").checked = false;
      detailMessage("");
      var booking = selectedBooking();
      if (booking && selectedPatient()) paintCompare(booking, selectedPatient());
      paintPatientResults(booking);
    });
    $("approve-review").addEventListener("click", function () {
      showConfirm("approve");
    });
    $("decline-review").addEventListener("click", function () {
      showConfirm("decline");
    });
    $("confirm-back").addEventListener("click", function () {
      if (busy) return;
      confirmMode = "";
      detailMessage("");
      paintDetail();
    });
    $("confirm-run").addEventListener("click", runConfirm);
    var clockNote = document.createElement("p");
    clockNote.className = "patient-meta";
    clockNote.textContent = "期限の表示は、このブラウザの時刻で分類しています。端末の時刻がずれていると、確認待ちと期限切れの表示が前後します。承認できるかどうかは、実行時にサーバーが判定します。";
    $("page-message").insertAdjacentElement("afterend", clockNote);
  }

  function reclassify() {
    if (busy) return;
    var booking = selectedBooking();
    if (booking && confirmMode === "approve" && !canApprove(booking)) {
      confirmMode = "";
      detailMessage("確保期限または開始時刻を過ぎているため、承認できません。見送りはできます。");
    }
    paintList();
    paintDetail();
  }

  function showApp(user) {
    $("auth-gate").hidden = true;
    $("app").hidden = false;
    $("admin-email").textContent = user && user.email ? user.email : "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.LapinaAuth) return;
    bind();
    paintFilters();
    window.setInterval(reclassify, 60000);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") reclassify();
    });
    window.LapinaAuth.requireAdmin().then(function (session) {
      if (!session) return;
      showApp(session.user);
      checkAccess().then(function () {
        return refresh();
      }).catch(function (error) {
        pageMessage(error && error.message ? error.message : "仮予約を表示する権限を確認できません。");
      });
    });
  });
})();
