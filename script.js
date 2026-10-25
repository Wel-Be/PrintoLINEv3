(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const pdfFile = $("pdfFile");
  const fileName = $("fileName");
  const passwordArea = $("passwordArea");
  const pdfPassword = $("pdfPassword");
  const passwordSubmit = $("passwordSubmit");
  const status = $("status");
  const progressArea = $("progressArea");
  const progressBar = $("progressBar");
  const progressText = $("progressText");
  const extractedText = $("extractedText");
  const imagesArea = $("imagesArea");
  const shareText = $("shareText");
  const copyText = $("copyText");
  const shareImages = $("shareImages");
  const runOcr = $("runOcr");
  const cancelOcr = $("cancelOcr");
  const imageDialog = $("imageDialog");
  const enlargedImage = $("enlargedImage");

  let selectedFile = null;
  let pendingPasswordFile = null;
  let pageImages = [];
  let busy = false;

  // PDF.js worker is loaded from the same CDN as PDF.js.
  const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const configurePdfJs = () => {
    if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "pdf.worker.min.js";
  };

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = "status" + (type ? " " + type : "");
  }
  function setProgress(value, message) {
    progressArea.classList.remove("hidden");
    progressBar.style.width = Math.max(0, Math.min(100, value)) + "%";
    progressText.textContent = message;
  }
  function clearProgress() {
    progressArea.classList.add("hidden");
    progressBar.style.width = "0%";
  }
  function setBusy(value) {
    busy = value;
    pdfFile.disabled = value;
    passwordSubmit.disabled = value;
    runOcr.disabled = value || pageImages.length === 0;
  }
  function clearPrevious() {
    pageImages.forEach((p) => { if (p.url) URL.revokeObjectURL(p.url); });
    pageImages = [];
    imagesArea.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "PDFを選ぶと、ここにページ画像が表示されます。";
    imagesArea.append(empty);
    extractedText.value = "";
    shareText.disabled = true;
    shareImages.disabled = true;
    runOcr.disabled = true;
    passwordArea.classList.add("hidden");
    pdfPassword.value = "";
    clearProgress();
  }
  function formatError(error) {
    if (error && (error.name === "PasswordException" || error.code === 1 || error.code === 2)) {
      return "このPDFはパスワードで保護されているか、入力したパスワードが違います。パスワードを入力して「再試行」を押してください。";
    }
    if (error && /Invalid PDF|PDF structure|Failed to parse/i.test(error.message || "")) {
      return "PDFを読み込めませんでした。ファイルが壊れていないか、正しいPDFか確認してください。";
    }
    if (error && /memory|allocation|canvas/i.test(error.message || "")) {
      return "端末のメモリ不足などで処理できませんでした。ほかのアプリを閉じるか、ページ数の少ないPDFでお試しください。";
    }
    return "処理に失敗しました。PDFを確認し、もう一度お試しください。\n詳細: " + ((error && error.message) || "不明なエラー");
  }

  pdfFile.addEventListener("change", async () => {
    const file = pdfFile.files && pdfFile.files[0];
    if (!file) return;
    selectedFile = file;
    pendingPasswordFile = file;
    fileName.textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`;
    clearPrevious();
    setStatus("");
    if (file.size > 30 * 1024 * 1024) {
      setStatus("ファイルサイズが大きいため、処理に時間がかかったり失敗したりする場合があります。");
    }
    await processPdf(file, "");
  });

  passwordSubmit.addEventListener("click", async () => {
    if (!pendingPasswordFile) return;
    await processPdf(pendingPasswordFile, pdfPassword.value);
  });

  async function processPdf(file, password) {
    if (busy) return;
    if (!window.pdfjsLib) {
      setStatus("PDF処理ライブラリを読み込めませんでした。インターネット接続を確認してページを再読み込みしてください。", "error");
      return;
    }
    configurePdfJs();
    clearPrevious();
    setBusy(true);
    setStatus("PDFを読み込んでいます…");
    let pdf = null;
    try {
      const data = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(data), password });
      loadingTask.onPassword = (updatePassword, reason) => {
        pendingPasswordFile = file;
        passwordArea.classList.remove("hidden");
        setStatus(reason === window.pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
          ? "パスワードが違うようです。正しいパスワードを入力してください。"
          : "このPDFにはパスワードが必要です。入力して「再試行」を押してください。", "error");
        // Prevent repeated callback attempts with the same password.
        loadingTask.destroy().catch(() => {});
      };
      pdf = await loadingTask.promise;
      passwordArea.classList.add("hidden");
      pdfPassword.value = "";
      const textParts = [];
      pageImages = [];
      imagesArea.replaceChildren();

      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        setProgress((pageNo - 1) / pdf.numPages * 100, `ページ ${pageNo} / ${pdf.numPages} を処理中…`);
        let page;
        try {
          page = await pdf.getPage(pageNo);
          const textContent = await page.getTextContent();
          // Sort items by approximate vertical position then horizontal position for a more readable order.
          const items = textContent.items.filter((item) => typeof item.str === "string" && item.str.trim());
          items.sort((a, b) => {
            const ay = a.transform ? a.transform[5] : 0;
            const by = b.transform ? b.transform[5] : 0;
            if (Math.abs(ay - by) > 3) return by - ay;
            return (a.transform ? a.transform[4] : 0) - (b.transform ? b.transform[4] : 0);
          });
          const pageText = items.map((item) => item.str).join(" ").replace(/[ \t]+/g, " ").trim();
          if (pageText) textParts.push(`【${pageNo}ページ】\n${pageText}`);

          // Render to a canvas sized for readable text without excessive memory use.
          const baseViewport = page.getViewport({ scale: 1 });
          const maxDimension = 1800;
          const scale = Math.min(2, maxDimension / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale: Math.max(0.8, scale) });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) throw new Error("Canvasを利用できません");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          const blob = await new Promise((resolve, reject) => canvas.toBlob(
            (result) => result ? resolve(result) : reject(new Error("JPEG画像を作成できませんでした")),
            "image/jpeg", 0.88
          ));
          const imageRecord = { pageNo, blob, url: URL.createObjectURL(blob), name: `${file.name.replace(/\.pdf$/i, "")}-page-${pageNo}.jpg` };
          pageImages.push(imageRecord);
          addImageCard(imageRecord);
          canvas.width = 0;
          canvas.height = 0;
          page.cleanup();
        } catch (pageError) {
          console.error("Page processing error", pageNo, pageError);
          setStatus(`ページ ${pageNo} の処理に失敗しました。他のページは可能な範囲で処理を続けます。`, "error");
        }
      }
      extractedText.value = textParts.join("\n\n");
      shareText.disabled = !extractedText.value.trim();
      shareImages.disabled = pageImages.length === 0;
      setProgress(100, `完了：${pdf.numPages}ページ中、画像 ${pageImages.length} 枚を作成しました。`);
      if (!extractedText.value.trim()) {
        setStatus("画像変換は完了しましたが、抽出できる文字が見つかりませんでした。画像だけのPDFの場合は、下の「文字認識（OCR）を実行」を押してください（手入力もできます）。", "success");
      } else {
        setStatus("処理が完了しました。文章を確認・編集してから共有してください。", "success");
      }
    } catch (error) {
      console.error(error);
      const isPassword = error && (error.name === "PasswordException" || error.code === 1 || error.code === 2);
      if (isPassword) {
        passwordArea.classList.remove("hidden");
        setStatus("パスワードが必要か、入力内容が違います。入力欄にパスワードを入れて「再試行」を押してください。", "error");
      } else {
        setStatus(formatError(error), "error");
      }
    } finally {
      if (pdf && pdf.destroy) { try { await pdf.destroy(); } catch (_) {} }
      setBusy(false);
    }
  }

  // ---- OCR (Tesseract.js, runs in the browser; loaded only when the button is pressed) ----
  const TESSERACT_SRC = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";
  let ocrWorker = null;
  let ocrCancelled = false;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) { resolve(); return; }
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error("OCRライブラリを読み込めませんでした。インターネット接続を確認してください。"));
      document.head.append(el);
    });
  }
  // Japanese OCR output often has spaces between characters; remove them between Japanese characters.
  function tidyOcrText(text) {
    const jp = "\u3040-\u30ff\u3400-\u9fff\uff00-\uffef\u3000-\u303f";
    const re = new RegExp("([" + jp + "])[ \t]+(?=[" + jp + "])", "g");
    return text.replace(re, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  runOcr.addEventListener("click", async () => {
    if (busy || !pageImages.length) return;
    const targets = pageImages.slice();
    if (!targets.length) { setStatus("OCRに使える画像がありません。PDFを読み込み直してください。", "error"); return; }
    ocrCancelled = false;
    setBusy(true);
    cancelOcr.classList.remove("hidden");
    setStatus("文字認識を準備しています…（初回は言語データの読み込みに時間がかかります）");
    let currentIndex = 0;
    const results = [];
    try {
      await loadScript(TESSERACT_SRC);
      ocrWorker = await window.Tesseract.createWorker("jpn+eng", 1, {
        logger: (m) => {
          if (!m) return;
          if (m.status === "recognizing text") {
            setProgress((currentIndex + m.progress) / targets.length * 100, `文字認識中：ページ ${targets[currentIndex].pageNo}（${currentIndex + 1} / ${targets.length}）`);
          } else if (/loading|initializ/i.test(m.status || "")) {
            setProgress(0, "言語データを読み込み中…（初回のみ時間がかかります）");
          }
        }
      });
      for (currentIndex = 0; currentIndex < targets.length; currentIndex++) {
        if (ocrCancelled) break;
        const t = targets[currentIndex];
        setProgress(currentIndex / targets.length * 100, `文字認識中：ページ ${t.pageNo}（${currentIndex + 1} / ${targets.length}）`);
        const { data } = await ocrWorker.recognize(t.blob);
        const text = tidyOcrText(data && data.text ? data.text : "");
        if (text) results.push(`【${t.pageNo}ページ（OCR）】\n${text}`);
      }
      if (ocrCancelled) {
        setStatus("文字認識を中止しました。", "");
      }
      if (results.length) {
        const current = extractedText.value.trim();
        extractedText.value = (current ? current + "\n\n" : "") + results.join("\n\n");
        const hasText = !!extractedText.value.trim();
        shareText.disabled = !hasText;
        setProgress(100, "文字認識が終わりました。");
        if (!ocrCancelled) setStatus("文字認識が完了しました。誤認識が含まれることがあるため、文章を確認・編集してから共有してください。", "success");
      } else if (!ocrCancelled) {
        setProgress(100, "文字認識が終わりました。");
        setStatus("文字を認識できませんでした。画像が不鮮明な可能性があります。必要な文章は手入力してください。", "error");
      }
    } catch (error) {
      console.error("OCR error", error);
      if (ocrCancelled) {
        setStatus("文字認識を中止しました。", "");
      } else {
        setStatus("文字認識に失敗しました。通信状況を確認し、もう一度お試しください。\n詳細: " + ((error && error.message) || "不明なエラー"), "error");
      }
    } finally {
      if (ocrWorker) { try { await ocrWorker.terminate(); } catch (_) {} ocrWorker = null; }
      cancelOcr.classList.add("hidden");
      setBusy(false);
    }
  });
  cancelOcr.addEventListener("click", async () => {
    ocrCancelled = true;
    cancelOcr.disabled = true;
    if (ocrWorker) { try { await ocrWorker.terminate(); } catch (_) {} }
    cancelOcr.disabled = false;
  });

  function addImageCard(record) {
    if (imagesArea.querySelector(".empty-state")) imagesArea.replaceChildren();
    const card = document.createElement("article");
    card.className = "page-card";
    const top = document.createElement("div");
    top.className = "page-topline";
    const label = document.createElement("strong");
    label.textContent = `ページ ${record.pageNo}`;
    const save = document.createElement("button");
    save.className = "button secondary";
    save.textContent = "JPEGを保存";
    save.addEventListener("click", () => downloadBlob(record.blob, record.name));
    top.append(label, save);
    const img = document.createElement("img");
    img.className = "page-image";
    img.src = record.url;
    img.alt = `PDFの${record.pageNo}ページ`;
    img.loading = "lazy";
    img.addEventListener("click", () => {
      enlargedImage.src = record.url;
      if (typeof imageDialog.showModal === "function") imageDialog.showModal();
      else window.open(record.url, "_blank", "noopener");
    });
    card.append(top, img);
    imagesArea.append(card);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function sharePlainText() {
    const text = extractedText.value.trim();
    if (!text) { setStatus("共有する文章を入力してください。", "error"); return; }
    try {
      if (navigator.share) {
        await navigator.share({ title: "PrintoLINE", text });
        setStatus("共有メニューを開きました。", "success");
      } else if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        setStatus("このブラウザでは共有メニューを利用できないため、文章をコピーしました。", "success");
      } else {
        throw new Error("共有機能が利用できません");
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setStatus("文章を共有できませんでした。文章を選択してコピーしてください。", "error");
    }
  }
  shareText.addEventListener("click", sharePlainText);
  extractedText.addEventListener("input", () => {
    const hasText = !!extractedText.value.trim();
    shareText.disabled = !hasText;
  });
  copyText.addEventListener("click", async () => {
    const text = extractedText.value;
    if (!text) { setStatus("コピーする文章がありません。", "error"); return; }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("文章をコピーしました。", "success");
    } catch (_) {
      extractedText.focus(); extractedText.select();
      setStatus("自動コピーできませんでした。選択した文章をコピーしてください。");
    }
  });

  shareImages.addEventListener("click", async () => {
    if (!pageImages.length) return;
    try {
      const files = pageImages.map((p) => new File([p.blob], p.name, { type: "image/jpeg" }));
      if (navigator.canShare && navigator.canShare({ files }) && navigator.share) {
        await navigator.share({ files, title: "PrintoLINEのプリント画像" });
        setStatus("画像の共有メニューを開きました。LINEを選んでください。", "success");
      } else {
        setStatus("この端末・ブラウザでは複数画像の一括共有に対応していません。各ページの「JPEGを保存」から保存して共有してください。", "error");
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setStatus("画像を共有できませんでした。各ページの「JPEGを保存」から保存してください。", "error");
    }
  });

  $("closeImageDialog").addEventListener("click", () => imageDialog.close());
  imageDialog.addEventListener("click", (event) => {
    if (event.target === imageDialog) imageDialog.close();
  });

  const OFUSE_URL = "https://ofuse.me/f3a8ad6a";
  $("ofuseLink").href = OFUSE_URL;

  // Warn on normal page exit when work is in progress. Browsers may not show this in every case.
  window.addEventListener("beforeunload", (event) => {
    const hasWork = !!(selectedFile || extractedText.value.trim() || pageImages.length);
    if (hasWork) { event.preventDefault(); event.returnValue = ""; }
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("Service worker registration failed", error));
    });
  }
})();
