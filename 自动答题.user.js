// ==UserScript==
// @name         自动答题助手
// @namespace    https://github.com/auto-answer-assistant
// @version      1.1.0
// @description  智能识别网页题目，调用AI API自动作答，支持超星学习通
// @author       Auto Answer Assistant
// @match        *://*/*
// @match        file:///*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_notification
// @connect      *
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 默认设置 ====================
  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 500,
    topP: 0.9,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stop: '',
    systemPrompt: `你是答题助手，必须严格按以下格式回答：

【选择题规则】
- 单选题：只返回一个字母（如：A）
- 多选题：按顺序连续返回字母（如：AB、ACD）
- 判断题：对返回A，错返回B

【填空题规则】
- 只返回答案内容
- 多空用英文逗号分隔（如：答案1,答案2）

【严格禁止】
- 禁止添加任何解释文字
- 禁止重复题目内容
- 禁止添加引号或标点
- 禁止说"答案是"等前缀

【正确示例】
单选题 → A
多选题 → ABC
填空题 → 北京
多空题 → 李白,杜甫

现在请直接回答：`,
    autoDetect: true,
    autoFill: true,
    confirmBeforeFill: false,
    delayTime: 1000,
    retryCount: 3,
    onlyFillEmptyInputs: false,
    contextBeforeCount: 0,
    contextAfterCount: 0,
    stream: false,
    enableNotifications: true,
    baseUrl: 'https://api.openai.com',
    chatPath: '/v1/chat/completions',
    isReasoning: false,
    parallelCount: 3,
    apiProvider: 'openai'
  };

  // ==================== 存储适配层（兼容各油猴扩展） ====================
  const Storage = {
    _prefix: 'autoAnswer_',
    get(key, defaultValue) {
      try {
        const val = GM_getValue(this._prefix + key);
        return val !== undefined ? val : defaultValue;
      } catch (e) {
        try {
          const raw = localStorage.getItem(this._prefix + key);
          return raw !== null ? JSON.parse(raw) : defaultValue;
        } catch {
          return defaultValue;
        }
      }
    },
    set(key, value) {
      try {
        GM_setValue(this._prefix + key, value);
      } catch (e) {
        try {
          localStorage.setItem(this._prefix + key, JSON.stringify(value));
        } catch { /* ignore */ }
      }
    },
    remove(key) {
      try {
        GM_deleteValue(this._prefix + key);
      } catch (e) {
        try {
          localStorage.removeItem(this._prefix + key);
        } catch { /* ignore */ }
      }
    }
  };

  // ==================== API 调用模块 ====================
  function isReasoningModel(model) {
    if (!model) return false;
    const reasoningModels = ['o1', 'o1-mini', 'o1-preview', 'deepseek-reasoner', 'r1'];
    return reasoningModels.some(rm => model.toLowerCase().includes(rm));
  }

  function buildQuestionContent(questionPayload) {
    if (typeof questionPayload === 'string') return questionPayload;
    const currentText = questionPayload?.text || '';
    const before = Array.isArray(questionPayload?.context?.before) ? questionPayload.context.before : [];
    const after = Array.isArray(questionPayload?.context?.after) ? questionPayload.context.after : [];
    if (before.length === 0 && after.length === 0) return currentText;
    const sections = ['请只回答"当前题目"，不要回答上下文题目。上下文仅用于补全断句、连接前后文和理解题干。'];
    if (before.length > 0) sections.push(`前文题目：\n${before.map((item, i) => `${i + 1}. ${item}`).join('\n')}`);
    sections.push(`当前题目：\n${currentText}`);
    if (after.length > 0) sections.push(`后文题目：\n${after.map((item, i) => `${i + 1}. ${item}`).join('\n')}`);
    return sections.join('\n\n');
  }

  function extractFinalAnswer(content) {
    if (!content || typeof content !== 'string') return content;
    let cleaned = content.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
    cleaned = cleaned.replace(/<\/?think>/gi, '').trim();
    const answerMatch = cleaned.match(/<answer>([\s\S]*?)<\/answer>/i);
    if (answerMatch) return answerMatch[1].trim();
    const finalMatch = cleaned.match(/(?:最终答案|答案是|答案为|答案|Final Answer)[：:]\s*([A-Z]+|.+?)(?:\s|$|。|，)/i);
    if (finalMatch) return finalMatch[1].trim();
    if (cleaned.length <= 50) {
      const letterMatch = cleaned.match(/^[A-Z]+$/);
      if (letterMatch) return letterMatch[0];
      const lastLetterMatch = cleaned.match(/([A-Z]+)\s*$/);
      if (lastLetterMatch) return lastLetterMatch[1];
      return cleaned;
    }
    const lines = cleaned.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine.length <= 50) {
        const letterMatch = lastLine.match(/([A-Z]+)/);
        if (letterMatch) return letterMatch[1];
        return lastLine;
      }
    }
    return cleaned;
  }

  function callAPI(questionPayload, settings) {
    return new Promise((resolve, reject) => {
      if (!settings.apiKey) { reject(new Error('API密钥未设置')); return; }
      const url = `${settings.baseUrl}${settings.chatPath}`;
      const isReasoning = settings.isReasoning || isReasoningModel(settings.model);
      const messages = [];
      if (isReasoning) {
        const promptContent = buildQuestionContent(questionPayload);
        let userContent = promptContent;
        if (settings.systemPrompt) userContent = `${settings.systemPrompt}\n\n${promptContent}`;
        messages.push({ role: 'user', content: userContent });
      } else {
        if (settings.systemPrompt) messages.push({ role: 'system', content: settings.systemPrompt });
        messages.push({ role: 'user', content: buildQuestionContent(questionPayload) });
      }
      const body = { model: settings.model, messages };
      if (isReasoning) {
        body.max_completion_tokens = settings.maxTokens || 2000;
      } else {
        body.temperature = settings.temperature || 0.3;
        body.max_tokens = settings.maxTokens || 500;
        if (settings.topP !== undefined && settings.topP !== null) body.top_p = settings.topP;
        if (settings.frequencyPenalty !== undefined && settings.frequencyPenalty !== null) body.frequency_penalty = settings.frequencyPenalty;
        if (settings.presencePenalty !== undefined && settings.presencePenalty !== null) body.presence_penalty = settings.presencePenalty;
        if (settings.stop) body.stop = settings.stop.split(',').map(s => s.trim()).filter(Boolean);
      }
      body.stream = settings.stream || false;
      console.log('[AutoAnswer] API请求:', { url, model: settings.model, isReasoning });
      GM_xmlhttpRequest({
        method: 'POST', url, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
        data: JSON.stringify(body), timeout: 60000,
        onload(response) {
          try {
            if (response.status < 200 || response.status >= 300) {
              let errorMessage;
              try { const parsed = JSON.parse(response.responseText); errorMessage = parsed.error?.message || `HTTP ${response.status}`; } catch { errorMessage = `HTTP ${response.status}`; }
              reject(new Error(`API错误: ${errorMessage}`)); return;
            }
            const data = JSON.parse(response.responseText);
            if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) { reject(new Error('API响应格式错误: 缺少choices字段')); return; }
            const choice = data.choices[0]; const message = choice.message || choice.text;
            if (!message) { reject(new Error('API响应格式错误: 缺少message字段')); return; }
            let answerContent = message.content || message;
            if (isReasoning && typeof answerContent === 'string') answerContent = extractFinalAnswer(answerContent);
            resolve({ success: true, answer: answerContent, usage: data.usage || {}, model: data.model || settings.model });
          } catch (e) { reject(new Error(`解析响应失败: ${e.message}`)); }
        },
        onerror() { reject(new Error('网络请求失败')); },
        ontimeout() { reject(new Error('请求超时（60秒）')); }
      });
    });
  }

  // ==================== 题目检测模块 ====================
  function detectQuestions(customSelector) {
    const detectedQuestions = [];
    if (customSelector) {
      try { const elements = document.querySelectorAll(customSelector); for (const el of elements) { const q = extractQuestion(el); if (q) detectedQuestions.push(q); } } catch (e) { console.warn('[AutoAnswer] 自定义选择器出错:', e); }
    } else {
      const allSelectors = [
        '.TiMu .questionLi', '.TiMu .singleQuesId', '.questionLi.singleQuesId', '.TiMu [data]',
        'li.subject', '.exam-subjects li.subject', '.subjects-jit-display > li', 'ng-form.subject', 'form.subject', '.subject[ng-class]',
        '.question', '.question-item', '.question-box', '.exam-question', '[data-question]', '.problem', '.problem-item', '.quiz-item', '.test-item'
      ];
      for (const selector of allSelectors) { try { const elements = document.querySelectorAll(selector); for (const el of elements) { const q = extractQuestion(el); if (q) detectedQuestions.push(q); } } catch (e) { /* ignore */ } }
    }
    return deduplicateQuestions(detectedQuestions);
  }

  function extractQuestion(element) {
    if (!element) return null;
    let questionId = element.getAttribute('data') || element.getAttribute('id') || element.getAttribute('data-question-id') || `q-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    let questionType = element.getAttribute('typename') || element.getAttribute('data-type') || element.getAttribute('ng-class') || 'unknown';
    const classList = element.className || '';
    const ngClassAttr = element.getAttribute('ng-class') || '';
    if (classList.includes('single_selection') || ngClassAttr.includes('single_selection')) questionType = '单选题';
    else if (classList.includes('multiple_selection') || ngClassAttr.includes('multiple_selection')) questionType = '多选题';
    else if (classList.includes('true_or_false') || ngClassAttr.includes('true_or_false')) questionType = '判断题';
    else if (classList.includes('fill_in_blank') || ngClassAttr.includes('fill_in_blank')) questionType = '填空题';
    else if (classList.includes('short_answer') || ngClassAttr.includes('short_answer')) questionType = '简答题';
    else if (classList.includes('matching') || ngClassAttr.includes('matching')) questionType = '匹配题';
    else if (questionType.includes('subject.type')) {
      if (element.querySelector('input[type="radio"]') && !element.querySelector('input[type="checkbox"]')) questionType = '单选题';
      else if (element.querySelector('input[type="checkbox"]')) questionType = '多选题';
      else if (element.querySelector('input[type="text"], textarea')) questionType = '填空题';
    }
    if (questionType === 'unknown') {
      const innerNgIf = element.querySelector('[ng-if*="subject.type"]');
      if (innerNgIf) { const ngIf = innerNgIf.getAttribute('ng-if') || ''; if (ngIf.includes('true_or_false')) questionType = '判断题'; else if (ngIf.includes('single_selection')) questionType = '单选题'; else if (ngIf.includes('multiple_selection')) questionType = '多选题'; else if (ngIf.includes('fill_in_blank')) questionType = '填空题'; else if (ngIf.includes('short_answer')) questionType = '简答题'; }
    }
    if (questionType === 'unknown' && element.querySelector('.subject-options')) { if (element.querySelector('input[type="radio"]')) questionType = '单选题'; else if (element.querySelector('input[type="checkbox"]')) questionType = '多选题'; else if (element.querySelector('input[type="text"], textarea')) questionType = '填空题'; }
    let text = '';
    const markName = element.querySelector('.mark_name, h3.mark_name, .workTextWrap');
    if (markName) text = markName.textContent.trim();
    if (!text) { const subjectDesc = element.querySelector('.subject-description'); if (subjectDesc) text = subjectDesc.textContent.trim(); }
    if (!text) { const summaryTitle = element.querySelector('.summary-title'); if (summaryTitle) { const clone = summaryTitle.cloneNode(true); clone.querySelectorAll('.subject-resort-index, .answer-error').forEach(el => el.remove()); text = clone.textContent.trim(); } }
    if (!text) { for (const sel of ['.question-title', '.question-content', '.problem-title', '.stem', '.question-stem', 'h3', 'h4']) { const titleEl = element.querySelector(sel); if (titleEl) { text = titleEl.textContent.trim(); if (text.length >= 5) break; } } }
    if (!text) { const clone = element.cloneNode(true); ['.subject-options', '.subject-body', '.option', '.options', '.answer-options', '.subject-message', '.subject-score', 'button', 'input', 'textarea', '.btn', '.button', '.subject-point', '.summary-sub-title'].forEach(sel => { clone.querySelectorAll(sel).forEach(el => el.remove()); }); text = clone.textContent.trim(); }
    text = cleanQuestionText(text);
    if (text.length < 5 || text.length > 2000) return null;
    const options = extractOptions(element);
    const inputs = extractInputs(element);
    const typeLC = questionType.toLowerCase();
    if ((typeLC.includes('单选') || typeLC.includes('多选') || typeLC.includes('判断') || typeLC.includes('selection') || typeLC.includes('true_or_false')) && options.length > 0) text = buildQuestionWithOptions(text, options, questionType);
    return { id: questionId, text, type: questionType, element, options, inputs, answered: false, answer: null };
  }

  function buildQuestionWithOptions(questionText, options, questionType) {
    let fullText = questionText + '\n';
    const typeLC = questionType.toLowerCase();
    if (typeLC.includes('单选')) fullText += '（单选题，请只回答一个选项字母，如：A）\n';
    else if (typeLC.includes('多选')) fullText += '（多选题，请回答所有正确选项字母，如：ABC）\n';
    else if (typeLC.includes('判断')) fullText += '（判断题，请回答A表示对，B表示错）\n';
    fullText += '选项：\n';
    options.forEach(opt => { const letter = opt.value || ''; const content = opt.text || ''; if (letter && content) { let c = content.trim(); if (c.startsWith(letter)) c = c.substring(1).trim(); if (c.startsWith('.') || c.startsWith('、') || c.startsWith(':')) c = c.substring(1).trim(); fullText += `${letter}. ${c}\n`; } });
    return fullText.trim();
  }

  function cleanQuestionText(text) { text = text.replace(/^\d+\.\s*/, ''); text = text.replace(/\([^)]*题[^)]*分\)/g, ''); text = text.replace(/\s+/g, ' ').trim(); return text; }

  function extractOptions(element) {
    const options = []; const seen = new Set();
    const answerBgs = element.querySelectorAll('.answerBg');
    answerBgs.forEach(bg => { const optionSpan = bg.querySelector('.num_option, span[data]'); const value = (optionSpan?.getAttribute('data') || optionSpan?.textContent || '').trim().toUpperCase(); const answerP = bg.querySelector('.answer_p'); const text = (answerP?.textContent || bg.textContent || '').trim(); if (value && !seen.has(value)) { seen.add(value); options.push({ value, text, element: bg }); } });
    if (options.length > 0) return options;
    const ouchnOptions = element.querySelectorAll('.subject-options .option, .subject-options li.option');
    ouchnOptions.forEach((opt, index) => { let value = ''; const optionIndex = opt.querySelector('.option-index, span.option-index'); if (optionIndex) value = optionIndex.textContent.trim().toUpperCase(); if (!value) { const labelEl = opt.querySelector('.option-label, label'); if (labelEl) { const match = labelEl.textContent.trim().match(/^([A-Z])/i); if (match) value = match[1].toUpperCase(); } } if (!value) value = String.fromCharCode(65 + index); const contentEl = opt.querySelector('.option-content'); const text = contentEl ? contentEl.textContent.trim() : opt.textContent.trim(); if (value && !seen.has(value)) { seen.add(value); options.push({ value, text, element: opt }); } });
    if (options.length > 0) return options;
    const inputs = element.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach((input, index) => { const value = input.value || String.fromCharCode(65 + index); const label = input.closest('label') || input.parentElement; const text = label ? label.textContent.trim() : value; if (value && !seen.has(value)) { seen.add(value); options.push({ value, text, element: input }); } });
    return options;
  }

  function extractInputs(element) {
    const inputs = [];
    element.querySelectorAll('input[type="text"], textarea, .blankInpDiv input, .answerBg input, .subject-answers input[type="text"], .subject-answers textarea, .cloze-sub-subjects input[type="text"], .cloze-sub-subjects textarea, .answer-content textarea, .short-answer-view ~ textarea').forEach(input => { inputs.push({ element: input, type: input.tagName.toLowerCase(), value: input.value || '' }); });
    return inputs;
  }

  function deduplicateQuestions(questions) {
    const seenText = new Set(); const seenElements = new Set(); const unique = [];
    for (const q of questions) { if (q.element && seenElements.has(q.element)) continue; if (q.element) seenElements.add(q.element); if (!seenText.has(q.text)) { seenText.add(q.text); unique.push(q); } }
    return unique;
  }

  // ==================== 答案填写模块 ====================
  function detectQuestionType(element) {
    let type = element.getAttribute('typename') || ''; if (type) return type.toLowerCase();
    type = element.getAttribute('data-type') || ''; if (type) return type.toLowerCase();
    const className = element.className || ''; const ngClass = element.getAttribute('ng-class') || '';
    if (className.includes('single_selection') || className.includes('single-selection') || ngClass.includes('single_selection')) return '单选题';
    if (className.includes('multiple_selection') || className.includes('multiple-selection') || ngClass.includes('multiple_selection')) return '多选题';
    if (className.includes('true_or_false') || className.includes('true-or-false') || ngClass.includes('true_or_false')) return '判断题';
    if (className.includes('fill_in_blank') || className.includes('fill-in-blank') || ngClass.includes('fill_in_blank')) return '填空题';
    if (className.includes('short_answer') || className.includes('short-answer') || ngClass.includes('short_answer')) return '简答题';
    if (className.includes('matching') || ngClass.includes('matching')) return '匹配题';
    const innerNgIf = element.querySelector('[ng-if*="subject.type"]');
    if (innerNgIf) { const ngIf = innerNgIf.getAttribute('ng-if') || ''; if (ngIf.includes('true_or_false')) return '判断题'; if (ngIf.includes('single_selection')) return '单选题'; if (ngIf.includes('multiple_selection')) return '多选题'; if (ngIf.includes('fill_in_blank')) return '填空题'; if (ngIf.includes('short_answer')) return '简答题'; }
    if (element.querySelectorAll('input[type="radio"]').length > 0) return '单选题';
    if (element.querySelectorAll('input[type="checkbox"]').length > 0) return '多选题';
    if (element.querySelectorAll('.option, .answerBg, .subject-options .option').length > 0) return '单选题';
    if (element.querySelectorAll('input[type="text"], textarea').length > 0) return '填空题';
    if (element.querySelector('.edui-editor, textarea[id^="answerEditor"]')) return '填空题';
    return 'unknown';
  }

  function tryFillAnswer(element, answer) {
    const originalAnswer = answer.toString().trim(); const normalizedAnswer = originalAnswer.toUpperCase();
    let questionType = detectQuestionType(element);
    if (questionType.includes('填空') || questionType.includes('简答') || questionType.includes('问答') || questionType.includes('blank') || questionType.includes('short')) return fillBlankAnswer(element, originalAnswer, questionType);
    else if (questionType.includes('单选') || questionType.includes('判断') || questionType.includes('single') || questionType.includes('true_or_false')) return fillChoiceAnswer(element, normalizedAnswer, false);
    else if (questionType.includes('多选') || questionType.includes('multiple')) return fillChoiceAnswer(element, normalizedAnswer, true);
    else { if (/^[A-Z]+$/.test(normalizedAnswer)) { if (fillChoiceAnswer(element, normalizedAnswer, normalizedAnswer.length > 1)) return true; } if (fillBlankAnswer(element, originalAnswer, questionType)) return true; return fillChoiceAnswer(element, normalizedAnswer, false); }
  }

  function fillBlankAnswer(element, answer, questionType = '') {
    const isShortAnswer = questionType.includes('简答') || questionType.includes('问答') || questionType.includes('short');
    if (fillUEditor(element, answer)) { highlightElement(element, 'success'); return true; }
    const allInputs = Array.from(element.querySelectorAll('input[type="text"]:not([readonly]), textarea:not([style*="display: none"]), .blankInpDiv input, .answerBg input, .subject-answers input[type="text"], .subject-answers textarea, .cloze-sub-subjects input[type="text"], .cloze-sub-subjects textarea'));
    const uniqueInputs = [...new Set(allInputs)];
    if (uniqueInputs.length > 0) { const answers = (!isShortAnswer && uniqueInputs.length > 1) ? splitBlankAnswers(answer, uniqueInputs.length) : [answer]; let filledAny = false; for (let i = 0; i < uniqueInputs.length; i++) { if (setInputValue(uniqueInputs[i], i < answers.length ? answers[i] : (answers[answers.length - 1] || ''))) filledAny = true; } if (filledAny) { highlightElement(element, 'success'); return true; } }
    const editables = element.querySelectorAll('[contenteditable="true"]');
    if (editables.length > 0) { const answers = (!isShortAnswer && editables.length > 1) ? splitBlankAnswers(answer, editables.length) : [answer]; let filledAny = false; for (let i = 0; i < editables.length; i++) { editables[i].innerHTML = i < answers.length ? answers[i] : (answers[answers.length - 1] || ''); editables[i].dispatchEvent(new Event('input', { bubbles: true })); filledAny = true; } if (filledAny) { highlightElement(element, 'success'); return true; } }
    for (const iframe of element.querySelectorAll('iframe')) { try { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc.body && doc.body.contentEditable === 'true') { doc.body.innerHTML = `<p>${answer}</p>`; doc.body.dispatchEvent(new Event('input', { bubbles: true })); highlightElement(element, 'success'); return true; } } catch (e) { /* ignore */ } }
    highlightElement(element, 'error'); return false;
  }

  function fillUEditor(element, answer) {
    for (const textarea of element.querySelectorAll('textarea[id^="answerEditor"]')) {
      const editorId = textarea.id;
      try { if (typeof window.UE !== 'undefined') { const editor = window.UE.getEditor(editorId); if (editor && editor.setContent) { editor.setContent(answer); return true; } } } catch (e) { /* ignore */ }
      try { if (typeof window.$EDITORUI !== 'undefined') { for (const key in window.$EDITORUI) { const editor = window.$EDITORUI[key]; if (editor && editor.setContent) { editor.setContent(answer); return true; } } } } catch (e) { /* ignore */ }
      try { const container = element.querySelector('.edui-editor'); if (container) { const iframe = container.querySelector('iframe'); if (iframe) { const doc = iframe.contentDocument || iframe.contentWindow.document; if (doc.body) { doc.body.innerHTML = `<p>${answer}</p>`; doc.body.dispatchEvent(new Event('input', { bubbles: true })); return true; } } } } catch (e) { /* ignore */ }
    }
    return false;
  }

  function fillChoiceAnswer(element, answer, isMultiple) {
    const answerLetters = answer.replace(/[,、\s]/g, '').split('').filter(c => /[A-Z]/.test(c));
    if (answerLetters.length === 0) { if (answer.includes('对') || answer.includes('正确') || answer.includes('TRUE') || answer.includes('YES')) answerLetters.push('A'); else if (answer.includes('错') || answer.includes('错误') || answer.includes('FALSE') || answer.includes('NO')) answerLetters.push('B'); }
    let filled = false;
    // 1. 超星
    const answerBgs = element.querySelectorAll('.answerBg');
    if (answerBgs.length > 0) { for (const bg of answerBgs) { const optionSpan = bg.querySelector('.num_option, span[data]'); const optionLetter = (optionSpan?.getAttribute('data') || optionSpan?.textContent || '').trim().toUpperCase(); if (answerLetters.includes(optionLetter)) { bg.click(); filled = true; highlightElement(bg, 'choice'); if (!isMultiple) break; } } if (filled) { highlightElement(element, 'success'); return true; } }
    // 2. 广州开放大学
    const ouchnOptions = element.querySelectorAll('.subject-options .option, .subject-options li.option, .option-item');
    if (ouchnOptions.length > 0) { for (let i = 0; i < ouchnOptions.length; i++) { const opt = ouchnOptions[i]; let optionLetter = ''; const optionIndex = opt.querySelector('.option-index, span.option-index'); if (optionIndex) optionLetter = optionIndex.textContent.trim().toUpperCase(); if (!optionLetter) { const leftSpan = opt.querySelector('.left, span.left'); if (leftSpan) { const match = leftSpan.textContent.trim().match(/^([A-Z])/i); if (match) optionLetter = match[1].toUpperCase(); } } if (!optionLetter) { const labelEl = opt.querySelector('.option-label, label, .option-key'); if (labelEl) { const match = labelEl.textContent.trim().match(/^([A-Z])/i); if (match) optionLetter = match[1].toUpperCase(); } } if (!optionLetter) optionLetter = String.fromCharCode(65 + i); if (answerLetters.includes(optionLetter)) { let optionFilled = false; const input = opt.querySelector('input[type="radio"], input[type="checkbox"]'); const label = opt.querySelector('label'); if (input) { if (isMultiple && input.type === 'checkbox') optionFilled = !input.checked ? clickAngularCheckbox(input, label, opt) : true; else optionFilled = clickAngularCheckbox(input, label, opt); } else if (label) { label.click(); optionFilled = true; } else { opt.click(); optionFilled = true; } opt.click(); if (optionFilled) { filled = true; highlightElement(opt, 'choice'); } if (!isMultiple) break; } } if (filled) { highlightElement(element, 'success'); return true; } }
    // 3. 单选框
    const radios = element.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) { for (let i = 0; i < radios.length; i++) { const radio = radios[i]; const radioValue = (radio.value || '').toUpperCase(); const label = radio.closest('label') || radio.parentElement; const labelText = (label?.textContent || '').trim().toUpperCase(); const firstLetter = labelText.charAt(0); const indexLetter = String.fromCharCode(65 + i); let optIdxLetter = ''; const optIdx = radio.closest('.option, li')?.querySelector('.option-index'); if (optIdx) optIdxLetter = optIdx.textContent.trim().toUpperCase(); if (answerLetters.includes(radioValue) || answerLetters.includes(firstLetter) || answerLetters.includes(indexLetter) || answerLetters.includes(optIdxLetter)) { clickAngularCheckbox(radio, label, radio.closest('.option, li')); highlightElement(element, 'success'); return true; } } }
    // 4. 复选框
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length > 0) { for (let i = 0; i < checkboxes.length; i++) { const cb = checkboxes[i]; const cbValue = (cb.value || '').toUpperCase(); const label = cb.closest('label') || cb.parentElement; const labelText = (label?.textContent || '').trim().toUpperCase(); const firstLetter = labelText.charAt(0); const indexLetter = String.fromCharCode(65 + i); let optIdxLetter = ''; const optIdx = cb.closest('.option, li')?.querySelector('.option-index'); if (optIdx) optIdxLetter = optIdx.textContent.trim().toUpperCase(); if (answerLetters.includes(cbValue) || answerLetters.includes(firstLetter) || answerLetters.includes(indexLetter) || answerLetters.includes(optIdxLetter)) { if (!cb.checked) { clickAngularCheckbox(cb, label, cb.closest('.option, li')); filled = true; } else filled = true; } } if (filled) { highlightElement(element, 'success'); return true; } }
    // 5. 通用
    const clickableOptions = element.querySelectorAll('[class*="option"], [class*="choice"], [class*="answer"]');
    if (clickableOptions.length > 0) { for (let i = 0; i < clickableOptions.length; i++) { const opt = clickableOptions[i]; const optText = opt.textContent.trim().toUpperCase(); const indexLetter = String.fromCharCode(65 + i); for (const letter of answerLetters) { if (optText.startsWith(letter) || optText.startsWith(letter + '.') || optText.startsWith(letter + '、')) { opt.click(); const input = opt.querySelector('input'); if (input) { input.click(); input.checked = true; triggerAllEvents(input); } filled = true; highlightElement(opt, 'choice'); if (!isMultiple) break; } } if (filled && !isMultiple) break; } if (filled) { highlightElement(element, 'success'); return true; } }
    highlightElement(element, 'error'); return false;
  }

  function setInputValue(input, value) {
    try { const descriptor = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value'); if (descriptor && descriptor.set) descriptor.set.call(input, value); else input.value = value; input.focus(); triggerAllEvents(input); input.blur(); input.style.backgroundColor = '#e8f5e9'; setTimeout(() => { input.style.backgroundColor = ''; }, 2000); return true; } catch (e) { return false; }
  }

  function clickAngularCheckbox(input, label, optionElement) {
    try { const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }); const mu = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }); const cl = new MouseEvent('click', { bubbles: true, cancelable: true, view: window }); if (label) { label.dispatchEvent(md); label.dispatchEvent(mu); label.dispatchEvent(cl); if (input && !input.checked) { input.dispatchEvent(md); input.dispatchEvent(mu); input.dispatchEvent(cl); } } else { input.dispatchEvent(md); input.dispatchEvent(mu); input.dispatchEvent(cl); if (!input.checked) input.checked = true; } input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); injectAngularTrigger(input); return true; } catch (e) { return false; }
  }

  function injectAngularTrigger(element) {
    try { const tempId = 'aa-temp-' + Date.now(); element.setAttribute('data-aa-id', tempId); const script = document.createElement('script'); script.textContent = `(function(){try{var el=document.querySelector('[data-aa-id="${tempId}"]');if(el&&typeof angular!=='undefined'){var s=angular.element(el).scope();if(s){if(s.option)s.option.checked=true;if(s.$apply)s.$apply();else if(s.$digest)s.$digest();if(s.onChangeSubmission&&s.subject)s.onChangeSubmission(s.subject);}}if(el)el.removeAttribute('data-aa-id');}catch(e){}})();`; document.head.appendChild(script); script.remove(); } catch (e) { /* ignore */ }
  }

  function triggerAllEvents(element) {
    ['input', 'change', 'blur', 'keyup', 'keydown', 'keypress', 'click'].forEach(t => element.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })));
    try { element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: element.value })); } catch (e) { /* ignore */ }
    try { const ne = new Event('input', { bubbles: true }); Object.defineProperty(ne, 'target', { value: element }); element.dispatchEvent(ne); } catch (e) { /* ignore */ }
    try { if (typeof angular !== 'undefined') { const scope = angular.element(element).scope(); if (scope && scope.$apply) scope.$apply(); } } catch (e) { /* ignore */ }
    try { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch (e) { /* ignore */ }
  }

  function splitBlankAnswers(answer, count) { const parts = answer.split(/[，,、\n]/).map(i => i.trim()).filter(Boolean); if (parts.length >= count && count > 1) return parts.slice(0, count); return new Array(count).fill(answer.trim()); }

  function hasExistingAnswerContent(question) {
    const el = question?.element; if (!el) return false;
    for (const input of el.querySelectorAll('input[type="text"], textarea')) { if ((input.value || '').trim()) return true; }
    for (const editable of el.querySelectorAll('[contenteditable="true"]')) { if ((editable.textContent || '').trim()) return true; }
    for (const iframe of el.querySelectorAll('iframe')) { try { const doc = iframe.contentDocument || iframe.contentWindow?.document; if ((doc?.body?.innerText || '').trim()) return true; } catch (e) { /* ignore */ } }
    if (el.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').length > 0) return true;
    return false;
  }

  function highlightElement(element, type) {
    const colors = { success: { bg: '#e8f5e9', border: '#4caf50' }, error: { bg: '#ffebee', border: '#f44336' }, choice: { bg: '#e3f2fd', border: '#2196f3' } };
    const color = colors[type] || colors.success;
    const origBg = element.style.backgroundColor, origBorder = element.style.border, origTransition = element.style.transition;
    element.style.transition = 'all 0.3s ease'; element.style.backgroundColor = color.bg; element.style.border = `2px solid ${color.border}`;
    setTimeout(() => { element.style.backgroundColor = origBg; element.style.border = origBorder; element.style.transition = origTransition; }, 3000);
  }

  function showNotification(message, type = 'info') {
    const existing = document.querySelector('.aa-toast'); if (existing) existing.remove();
    const bgMap = { info: 'linear-gradient(135deg, #3b82f6, #2563eb)', success: 'linear-gradient(135deg, #34d399, #059669)', error: 'linear-gradient(135deg, #ef4444, #dc2626)', warning: 'linear-gradient(135deg, #f59e0b, #d97706)' };
    const n = document.createElement('div'); n.className = 'aa-toast'; n.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:360px;padding:12px 20px;background:${bgMap[type] || bgMap.info};color:#fff;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.2);font:500 14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;animation:aa-slideIn .3s ease-out;`;
    n.textContent = message; document.body.appendChild(n); n.addEventListener('click', () => n.remove());
    setTimeout(() => { if (n.parentNode) n.remove(); }, 3500);
  }

  function buildQuestionContext(questions, index, settings) {
    const bc = Math.max(0, parseInt(settings.contextBeforeCount || 0, 10)); const ac = Math.max(0, parseInt(settings.contextAfterCount || 0, 10));
    return { before: questions.slice(Math.max(0, index - bc), index).map(i => i.text), after: questions.slice(index + 1, index + 1 + ac).map(i => i.text) };
  }

  function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

  // ==================== 主控制器 ====================
  class AutoAnswerManager {
    constructor() {
      this.isRunning = false;
      this.detectedQuestions = [];
      this.answeredCount = 0;
      this.failedCount = 0;
      this.customSelector = null;
      this.isSelectingElement = false;
      this.highlightedElement = null;

      this.loadSettings();
      this.injectStyles();
      this.createPanel();
      this.registerMenuCommands();
      this.setupKeyboardShortcuts();

      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => this.onPageLoaded());
      else this.onPageLoaded();
    }

    loadSettings() { const saved = Storage.get('settings', {}); this.settings = { ...DEFAULT_SETTINGS, ...saved }; }
    saveSettings() { Storage.set('settings', this.settings); }

    onPageLoaded() { if (this.settings.autoDetect) this.detectQuestions(); this.observePageChanges(); }

    registerMenuCommands() {
      try {
        GM_registerMenuCommand('开始答题', () => this.startAnswering());
        GM_registerMenuCommand('停止答题', () => this.stopAnswering());
        GM_registerMenuCommand('重新检测', () => { this.customSelector = null; this.detectQuestions(); showNotification(`检测到 ${this.detectedQuestions.length} 个题目`, 'info'); });
      } catch (e) { /* ignore */ }
    }

    setupKeyboardShortcuts() {
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'A') { e.preventDefault(); this.startAnswering(); }
        else if (e.ctrlKey && e.shiftKey && e.key === 'S') { e.preventDefault(); this.stopAnswering(); }
      });
    }

    observePageChanges() {
      let timer = null;
      new MutationObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (this.settings.autoDetect) this.detectQuestions(); }, 500); }).observe(document.body, { childList: true, subtree: true });
    }

    detectQuestions() { this.detectedQuestions = detectQuestions(this.customSelector); this.updatePanelStats(); this.renderQuestionPreview(); return this.detectedQuestions; }

    async startAnswering() {
      if (this.isRunning) { showNotification('正在答题中，请勿重复操作', 'warning'); return; }
      this.detectQuestions();
      const questions = this.detectedQuestions;
      if (!questions || questions.length === 0) { showNotification('未检测到题目', 'warning'); return; }

      this.isRunning = true; this.answeredCount = 0; this.failedCount = 0;
      showNotification(`开始答题，共 ${questions.length} 题`, 'info');
      this.updatePanelStats();

      const pending = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (q.answered) continue;
        if (this.settings.onlyFillEmptyInputs && hasExistingAnswerContent(q)) { q.answered = true; q.answer = '[保留]'; this.answeredCount++; continue; }
        pending.push({ question: q, index: i });
      }
      if (pending.length === 0) { this.isRunning = false; showNotification('没有需要处理的题目', 'info'); this.updatePanelStats(); return; }

      const pc = Math.max(1, Math.min(10, this.settings.parallelCount || 1)); let nextIdx = 0;
      const processNext = async () => {
        while (nextIdx < pending.length && this.isRunning) {
          const { question, index } = pending[nextIdx++];
          let answer = null, success = false, errorMsg = null, retries = this.settings.retryCount || 0;
          while (retries >= 0 && this.isRunning) {
            try {
              const ctx = buildQuestionContext(questions, index, this.settings);
              const res = await callAPI({ text: question.text, context: ctx }, this.settings);
              if (res && res.success && res.answer) { answer = res.answer; const filled = tryFillAnswer(question.element, res.answer); if (filled !== false) { this.answeredCount++; success = true; } else { this.failedCount++; errorMsg = '填写失败'; } break; }
              else errorMsg = res?.error || '未知错误';
            } catch (e) { errorMsg = e.message; }
            retries--; if (retries >= 0 && this.isRunning) await new Promise(r => setTimeout(r, 1000));
          }
          if (!success) this.failedCount++;
          this.recordHistory(question.text, answer, success, errorMsg);
          this.updatePanelStats();
          if (this.settings.delayTime > 0) await new Promise(r => setTimeout(r, Math.min(this.settings.delayTime, 500)));
        }
      };
      const workers = []; for (let w = 0; w < pc; w++) workers.push(processNext());
      await Promise.all(workers);
      this.isRunning = false; this.printStatusReport();
      showNotification(`答题完成！成功: ${this.answeredCount}, 失败: ${this.failedCount}`, this.failedCount > 0 ? 'warning' : 'success');
      this.updatePanelStats();
    }

    stopAnswering() { this.isRunning = false; showNotification('已停止答题', 'info'); this.updatePanelStats(); }

    printStatusReport() {
      console.log('========================================');
      console.log(`[AutoAnswer] 总: ${this.detectedQuestions.length} 成功: ${this.answeredCount} 失败: ${this.failedCount}`);
      this.detectedQuestions.forEach((q, i) => { console.log(`${i + 1}. [${q.answered ? '✓' : '✗'}] ${q.text.substring(0, 30)}... ${q.answer || ''}`); });
      console.log('========================================');
    }

    recordHistory(question, answer, success, error) {
      try { const h = Storage.get('answerHistory', []); h.push({ question, answer, success, error, timestamp: Date.now() }); if (h.length > 500) h.splice(0, h.length - 500); Storage.set('answerHistory', h); } catch (e) { /* ignore */ }
    }

    // ==================== 元素选取模式 ====================
    startElementSelection() {
      this.isSelectingElement = true;
      if (!document.getElementById('aa-selector-styles')) {
        const s = document.createElement('style'); s.id = 'aa-selector-styles';
        s.textContent = `.aa-pick-highlight{outline:3px solid #06b6d4!important;outline-offset:2px!important;background:rgba(6,182,212,.1)!important;cursor:crosshair!important;}`;
        document.head.appendChild(s);
      }
      this._hoverHandler = (e) => { if (!this.isSelectingElement) return; e.stopPropagation(); if (e.target.closest('#aa-panel')) return; if (this.highlightedElement) this.highlightedElement.classList.remove('aa-pick-highlight'); this.highlightedElement = e.target; this.highlightedElement.classList.add('aa-pick-highlight'); };
      this._clickHandler = (e) => { if (!this.isSelectingElement) return; if (e.target.closest('#aa-panel')) return; e.preventDefault(); e.stopPropagation(); this.confirmSelection(); };
      this._keyHandler = (e) => { if (e.key === 'Escape') this.stopElementSelection(); };
      document.addEventListener('mouseover', this._hoverHandler, true);
      document.addEventListener('click', this._clickHandler, true);
      document.addEventListener('keydown', this._keyHandler, true);
      showNotification('点击选择题目元素，按 ESC 取消', 'info');
    }

    stopElementSelection() {
      this.isSelectingElement = false;
      if (this.highlightedElement) { this.highlightedElement.classList.remove('aa-pick-highlight'); this.highlightedElement = null; }
      if (this._hoverHandler) document.removeEventListener('mouseover', this._hoverHandler, true);
      if (this._clickHandler) document.removeEventListener('click', this._clickHandler, true);
      if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler, true);
    }

    confirmSelection() {
      if (!this.highlightedElement) return;
      const selector = this.generateSelector(this.highlightedElement);
      this.customSelector = selector;
      this.stopElementSelection();
      this.detectQuestions();
      const input = document.getElementById('aa-custom-selector');
      if (input) input.value = selector;
      showNotification(`选择器: ${selector}，检测到 ${this.detectedQuestions.length} 个题目`, 'success');
    }

    generateSelector(el) {
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith('aa-'));
        for (const cls of classes) { const s = '.' + cls; if (document.querySelectorAll(s).length >= 1 && document.querySelectorAll(s).length <= 100) return s; }
        if (classes.length > 0) { const s = '.' + classes.join('.'); if (document.querySelectorAll(s).length >= 1) return s; }
      }
      const tag = el.tagName.toLowerCase();
      for (const attr of ['data', 'typename', 'data-type', 'role', 'name']) { const v = el.getAttribute(attr); if (v) { const s = `${tag}[${attr}="${v}"]`; if (document.querySelectorAll(s).length >= 1) return s; } }
      if (el.parentElement && el.parentElement !== document.body && el.parentElement.className) { const pc = el.parentElement.className.trim().split(/\s+/).filter(c => c); if (pc.length > 0) { const s = `.${pc[0]} > ${tag}`; if (document.querySelectorAll(s).length >= 1 && document.querySelectorAll(s).length <= 100) return s; } }
      if (el.id) return `#${el.id}`;
      return tag;
    }

    // ==================== 常驻悬浮窗 UI ====================
    createPanel() {
      const panel = document.createElement('div');
      panel.id = 'aa-panel';
      const savedPos = Storage.get('panelPos', null);
      const savedSize = Storage.get('panelSize', null);
      if (savedPos && savedPos.collapsed === false) panel.classList.remove('aa-collapsed'); else panel.classList.add('aa-collapsed');
      panel.innerHTML = this.buildPanelHTML();
      // 恢复位置
      if (savedPos && savedPos.left) { panel.style.left = savedPos.left; panel.style.top = savedPos.top; panel.style.right = savedPos.right || 'auto'; }
      // 恢复尺寸和展开状态
      if (!panel.classList.contains('aa-collapsed')) {
        panel.querySelector('#aa-body').style.display = '';
        panel.querySelector('#aa-resize').style.display = '';
        panel.querySelector('#aa-title').innerHTML = '&#x2728; AutoAnswer';
        if (savedSize) { panel.style.width = savedSize.width + 'px'; panel.style.maxHeight = savedSize.height + 'px'; const body = panel.querySelector('#aa-body'); if (body) body.style.maxHeight = (savedSize.height - 48) + 'px'; }
      }
      document.body.appendChild(panel);
      this.bindPanelEvents();
      this.populateSettingsForm();
      this.updatePanelStats();
      this.loadHistory();
    }

    buildPanelHTML() {
      return `
        <div class="aa-header" id="aa-header">
          <span class="aa-header-title" id="aa-title">答</span>
        </div>
        <div class="aa-body" id="aa-body" style="display:none;">
          <!-- 标签页导航 -->
          <div class="aa-tabs">
            <button class="aa-tab active" data-tab="aa-tab-main">功能</button>
            <button class="aa-tab" data-tab="aa-tab-api">API</button>
            <button class="aa-tab" data-tab="aa-tab-adv">设置</button>
            <button class="aa-tab" data-tab="aa-tab-hist">历史</button>
          </div>

          <!-- ===== 功能标签 ===== -->
          <div class="aa-tab-content active" id="aa-tab-main">
            <div class="aa-section">
              <div class="aa-stats">
                <div class="aa-stat"><span class="aa-stat-n" id="aa-qc">0</span><span class="aa-stat-l">检测</span></div>
                <div class="aa-stat"><span class="aa-stat-n" id="aa-ac">0</span><span class="aa-stat-l">成功</span></div>
                <div class="aa-stat"><span class="aa-stat-n" id="aa-fc">0</span><span class="aa-stat-l">失败</span></div>
              </div>
              <div class="aa-status" id="aa-status">准备就绪</div>
            </div>
            <div class="aa-section">
              <div class="aa-btn-row">
                <button class="aa-btn aa-btn-p" id="aa-start">开始答题</button>
                <button class="aa-btn aa-btn-d" id="aa-stop" disabled>停止答题</button>
              </div>
              <div class="aa-btn-row">
                <button class="aa-btn aa-btn-s" id="aa-redetect">重新检测</button>
                <button class="aa-btn aa-btn-s" id="aa-pick">选取元素</button>
              </div>
            </div>
            <div class="aa-section">
              <div class="aa-label">自定义CSS选择器</div>
              <div class="aa-input-row">
                <input type="text" class="aa-input" id="aa-custom-selector" placeholder="如: .question, .TiMu">
                <button class="aa-btn aa-btn-sm aa-btn-ok" id="aa-apply-sel">应用</button>
              </div>
              <button class="aa-btn aa-btn-sm aa-btn-s" id="aa-clear-sel" style="margin-top:4px;width:100%;">清除选择器</button>
            </div>
            <div class="aa-section">
              <div class="aa-label">题目预览 (<span id="aa-qp-count">0</span>)</div>
              <div class="aa-preview" id="aa-qp">未检测到题目</div>
            </div>
          </div>

          <!-- ===== API标签 ===== -->
          <div class="aa-tab-content" id="aa-tab-api">
            <div class="aa-section">
              <div class="aa-label">API提供商预设</div>
              <select class="aa-input" id="aa-api-provider">
                <option value="openai">OpenAI (api.openai.com)</option>
                <option value="openai-o1">OpenAI o1 推理模型</option>
                <option value="deepseek">DeepSeek (api.deepseek.com)</option>
                <option value="deepseek-reasoner">DeepSeek R1 推理模型</option>
                <option value="custom">自定义</option>
                <option value="custom-reasoning">自定义 (推理模型)</option>
              </select>
            </div>
            <div class="aa-section">
              <div class="aa-label">API密钥</div>
              <div class="aa-input-row">
                <input type="password" class="aa-input" id="aa-api-key" placeholder="输入API密钥">
                <button class="aa-btn aa-btn-sm aa-btn-s" id="aa-toggle-key">👁</button>
              </div>
            </div>
            <div class="aa-section">
              <div class="aa-row-2">
                <div class="aa-col"><div class="aa-label">基础URL</div><input type="text" class="aa-input" id="aa-base-url"></div>
                <div class="aa-col"><div class="aa-label">Chat路径</div><input type="text" class="aa-input" id="aa-chat-path"></div>
              </div>
            </div>
            <div class="aa-section">
              <div class="aa-label">模型</div>
              <input type="text" class="aa-input" id="aa-model" placeholder="gpt-4o-mini">
            </div>
            <div class="aa-section">
              <div class="aa-row-2">
                <div class="aa-col"><div class="aa-label">温度 <span id="aa-temp-v">0.3</span></div><input type="range" class="aa-range" id="aa-temperature" min="0" max="2" step="0.1" value="0.3"></div>
                <div class="aa-col"><div class="aa-label">最大Token</div><input type="number" class="aa-input" id="aa-max-tokens" min="1" max="4096" value="500"></div>
              </div>
            </div>
            <div class="aa-section">
              <details class="aa-details">
                <summary>高级参数（通常无需调整）</summary>
                <div class="aa-details-body">
                  <div class="aa-row-2">
                    <div class="aa-col"><div class="aa-label">Top P <span id="aa-topp-v">0.9</span></div><input type="range" class="aa-range" id="aa-top-p" min="0" max="1" step="0.1" value="0.9"></div>
                    <div class="aa-col"><div class="aa-label">频率惩罚 <span id="aa-fp-v">0</span></div><input type="range" class="aa-range" id="aa-freq-pen" min="-2" max="2" step="0.1" value="0"></div>
                  </div>
                  <div class="aa-row-2">
                    <div class="aa-col"><div class="aa-label">存在惩罚 <span id="aa-pp-v">0</span></div><input type="range" class="aa-range" id="aa-pres-pen" min="-2" max="2" step="0.1" value="0"></div>
                    <div class="aa-col"><div class="aa-label">停止词</div><input type="text" class="aa-input" id="aa-stop" placeholder="如: \\n\\n, END"></div>
                  </div>
                </div>
              </details>
            </div>
            <div class="aa-section">
              <div class="aa-label">系统提示词</div>
              <textarea class="aa-textarea" id="aa-system-prompt" rows="4"></textarea>
            </div>
            <div class="aa-section">
              <label class="aa-switch"><input type="checkbox" id="aa-stream"><span class="aa-slider"></span></label><span class="aa-switch-l">启用流式响应</span>
            </div>
            <div class="aa-section">
              <div class="aa-btn-row">
                <button class="aa-btn aa-btn-ok" id="aa-save-settings">保存设置</button>
                <button class="aa-btn aa-btn-s" id="aa-test-api">测试API</button>
              </div>
              <div id="aa-api-result"></div>
            </div>
          </div>

          <!-- ===== 设置标签 ===== -->
          <div class="aa-tab-content" id="aa-tab-adv">
            <div class="aa-section">
              <div class="aa-sub-title">答题行为</div>
              <div class="aa-switch-row"><label class="aa-switch"><input type="checkbox" id="aa-auto-detect"><span class="aa-slider"></span></label><span class="aa-switch-l">自动检测页面题目</span></div>
              <div class="aa-switch-row"><label class="aa-switch"><input type="checkbox" id="aa-auto-fill"><span class="aa-slider"></span></label><span class="aa-switch-l">自动填写答案</span></div>
              <div class="aa-switch-row"><label class="aa-switch"><input type="checkbox" id="aa-confirm-fill"><span class="aa-slider"></span></label><span class="aa-switch-l">填写前确认</span></div>
              <div class="aa-switch-row"><label class="aa-switch"><input type="checkbox" id="aa-only-empty"><span class="aa-slider"></span></label><span class="aa-switch-l">仅填写空白题</span></div>
              <div class="aa-switch-row"><label class="aa-switch"><input type="checkbox" id="aa-enable-notify"><span class="aa-slider"></span></label><span class="aa-switch-l">显示页面通知</span></div>
            </div>
            <div class="aa-section">
              <div class="aa-row-2">
                <div class="aa-col"><div class="aa-label">延迟(ms)</div><input type="number" class="aa-input" id="aa-delay-time" min="0" max="10000" value="1000"></div>
                <div class="aa-col"><div class="aa-label">并发数</div><input type="number" class="aa-input" id="aa-parallel-count" min="1" max="10" value="3"></div>
              </div>
              <div class="aa-row-2" style="margin-top:8px;">
                <div class="aa-col"><div class="aa-label">重试次数</div><input type="number" class="aa-input" id="aa-retry-count" min="0" max="10" value="3"></div>
                <div class="aa-col"><div class="aa-label">上下文前/后题数</div>
                  <div class="aa-row-2"><input type="number" class="aa-input" id="aa-ctx-before" min="0" max="20" value="0" style="text-align:center;"><input type="number" class="aa-input" id="aa-ctx-after" min="0" max="20" value="0" style="text-align:center;"></div>
                </div>
              </div>
            </div>
            <div class="aa-section">
              <div class="aa-sub-title">数据管理</div>
              <div class="aa-btn-row">
                <button class="aa-btn aa-btn-s" id="aa-export">导出设置</button>
                <button class="aa-btn aa-btn-s" id="aa-import">导入设置</button>
              </div>
              <button class="aa-btn aa-btn-d" id="aa-reset" style="width:100%;margin-top:6px;">重置为默认设置</button>
            </div>
          </div>

          <!-- ===== 历史标签 ===== -->
          <div class="aa-tab-content" id="aa-tab-hist">
            <div class="aa-section">
              <div class="aa-sub-title" style="display:flex;justify-content:space-between;align-items:center;">答题历史 <button class="aa-btn aa-btn-sm aa-btn-d" id="aa-clear-hist">清空</button></div>
              <div class="aa-hist-list" id="aa-hist-list">暂无答题记录</div>
            </div>
          </div>
        </div>
        <div class="aa-resize-handle" id="aa-resize"></div>`;
    }

    bindPanelEvents() {
      const $ = (id) => document.getElementById(id);

      // 拖动 & 点击切换
      const header = $('aa-header');
      let hDown = false, hMoved = false, hSx, hSy, hSl, hSt;
      const savePanelPos = () => { const panel = $('aa-panel'); if (!panel) return; Storage.set('panelPos', { left: panel.style.left, top: panel.style.top, right: panel.style.right, collapsed: panel.classList.contains('aa-collapsed') }); };
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        hDown = true; hMoved = false;
        const panel = $('aa-panel');
        hSx = e.clientX; hSy = e.clientY; hSl = panel.offsetLeft; hSt = panel.offsetTop;
      });
      document.addEventListener('mousemove', (e) => {
        if (!hDown) return;
        const dx = e.clientX - hSx, dy = e.clientY - hSy;
        if (!hMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        hMoved = true;
        const panel = $('aa-panel');
        panel.style.left = (hSl + dx) + 'px'; panel.style.top = (hSt + dy) + 'px'; panel.style.right = 'auto';
      });
      document.addEventListener('mouseup', () => {
        if (!hDown) return;
        hDown = false;
        if (hMoved) { savePanelPos(); return; } // 拖动了，保存位置，不切换
        // 点击 → 展开/收起
        const body = $('aa-body'); const panel = $('aa-panel'); const resize = $('aa-resize'); const titleEl = $('aa-title');
        const collapsed = body.style.display === 'none';
        if (collapsed) {
          body.style.display = ''; resize.style.display = '';
          panel.classList.remove('aa-collapsed');
          titleEl.innerHTML = '&#x2728; AutoAnswer';
        } else {
          body.style.display = 'none'; resize.style.display = 'none';
          panel.classList.add('aa-collapsed');
          titleEl.innerHTML = '答';
        }
        savePanelPos();
      });

      // 拖拽调整大小
      const resizeHandle = $('aa-resize');
      let resizing = false, rStartX, rStartY, rStartW, rStartH;
      resizeHandle.addEventListener('mousedown', (e) => {
        resizing = true; const panel = $('aa-panel'); const rect = panel.getBoundingClientRect();
        rStartX = e.clientX; rStartY = e.clientY; rStartW = rect.width; rStartH = rect.height;
        e.preventDefault(); e.stopPropagation();
      });
      document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const panel = $('aa-panel');
        const newW = Math.max(280, rStartW + (e.clientX - rStartX));
        const newH = Math.max(200, rStartH + (e.clientY - rStartY));
        panel.style.width = newW + 'px';
        panel.style.maxHeight = newH + 'px';
        const body = $('aa-body'); if (body) body.style.maxHeight = (newH - 48) + 'px';
        Storage.set('panelSize', { width: newW, height: newH });
      });
      document.addEventListener('mouseup', () => { resizing = false; });

      // 标签页
      $('aa-panel').querySelectorAll('.aa-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          $('aa-panel').querySelectorAll('.aa-tab').forEach(t => t.classList.remove('active'));
          $('aa-panel').querySelectorAll('.aa-tab-content').forEach(c => c.classList.remove('active'));
          tab.classList.add('active');
          $(tab.dataset.tab).classList.add('active');
          if (tab.dataset.tab === 'aa-tab-hist') this.loadHistory();
        });
      });

      // 功能按钮
      $('aa-start').addEventListener('click', () => this.startAnswering());
      $('aa-stop').addEventListener('click', () => this.stopAnswering());
      $('aa-redetect').addEventListener('click', () => { this.customSelector = null; this.detectQuestions(); showNotification(`检测到 ${this.detectedQuestions.length} 个题目`, 'info'); });
      $('aa-pick').addEventListener('click', () => this.startElementSelection());
      $('aa-apply-sel').addEventListener('click', () => { const s = $('aa-custom-selector').value.trim(); if (!s) { showNotification('请输入CSS选择器', 'warning'); return; } this.customSelector = s; this.detectQuestions(); showNotification(`检测到 ${this.detectedQuestions.length} 个题目`, 'info'); });
      $('aa-clear-sel').addEventListener('click', () => { this.customSelector = null; $('aa-custom-selector').value = ''; this.detectQuestions(); showNotification(`检测到 ${this.detectedQuestions.length} 个题目`, 'info'); });

      // API密钥可见性
      $('aa-toggle-key').addEventListener('click', () => { const inp = $('aa-api-key'); inp.type = inp.type === 'password' ? 'text' : 'password'; });

      // 滑块实时值
      $('aa-temperature').addEventListener('input', (e) => { $('aa-temp-v').textContent = e.target.value; });
      $('aa-top-p').addEventListener('input', (e) => { $('aa-topp-v').textContent = e.target.value; });
      $('aa-freq-pen').addEventListener('input', (e) => { $('aa-fp-v').textContent = e.target.value; });
      $('aa-pres-pen').addEventListener('input', (e) => { $('aa-pp-v').textContent = e.target.value; });

      // API提供商
      $('aa-api-provider').addEventListener('change', (e) => this.onApiProviderChange(e.target.value));

      // 保存设置
      $('aa-save-settings').addEventListener('click', () => { this.saveSettingsFromForm(); showNotification('设置已保存', 'success'); });

      // 测试API
      $('aa-test-api').addEventListener('click', () => this.testAPI());

      // 导出
      $('aa-export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(this.settings, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'auto-answer-settings.json'; a.click(); URL.revokeObjectURL(a.href);
      });

      // 导入
      $('aa-import').addEventListener('click', () => {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = (e) => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (ev) => { try { this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(ev.target.result) }; this.saveSettings(); this.populateSettingsForm(); showNotification('导入成功', 'success'); } catch (err) { showNotification('导入失败: ' + err.message, 'error'); } }; reader.readAsText(file); };
        input.click();
      });

      // 重置
      $('aa-reset').addEventListener('click', () => {
        if (!confirm('确定重置所有设置吗？此操作不可恢复。')) return;
        this.settings = { ...DEFAULT_SETTINGS }; this.saveSettings(); this.populateSettingsForm(); Storage.set('answerHistory', []); showNotification('已重置为默认设置', 'success');
      });

      // 清空历史
      $('aa-clear-hist').addEventListener('click', () => { Storage.set('answerHistory', []); this.loadHistory(); });
    }

    onApiProviderChange(provider) {
      const presets = {
        openai: { baseUrl: 'https://api.openai.com', chatPath: '/v1/chat/completions', model: 'gpt-4o-mini', isReasoning: false },
        'openai-o1': { baseUrl: 'https://api.openai.com', chatPath: '/v1/chat/completions', model: 'o1-mini', isReasoning: true },
        deepseek: { baseUrl: 'https://api.deepseek.com', chatPath: '/v1/chat/completions', model: 'deepseek-chat', isReasoning: false },
        'deepseek-reasoner': { baseUrl: 'https://api.deepseek.com', chatPath: '/v1/chat/completions', model: 'deepseek-reasoner', isReasoning: true },
        custom: { baseUrl: this.settings.baseUrl || '', chatPath: this.settings.chatPath || '/v1/chat/completions', model: this.settings.model || '', isReasoning: false },
        'custom-reasoning': { baseUrl: this.settings.baseUrl || '', chatPath: this.settings.chatPath || '/v1/chat/completions', model: this.settings.model || '', isReasoning: true }
      };
      const p = presets[provider]; if (!p) return;
      if (!provider.startsWith('custom')) {
        document.getElementById('aa-base-url').value = p.baseUrl;
        document.getElementById('aa-chat-path').value = p.chatPath;
        document.getElementById('aa-model').value = p.model;
      }
      this.settings.apiProvider = provider;
    }

    populateSettingsForm() {
      const s = this.settings; const $ = (id) => document.getElementById(id);
      $('aa-api-provider').value = s.apiProvider || 'openai';
      $('aa-api-key').value = s.apiKey || '';
      $('aa-base-url').value = s.baseUrl || '';
      $('aa-chat-path').value = s.chatPath || '';
      $('aa-model').value = s.model || '';
      $('aa-temperature').value = s.temperature; $('aa-temp-v').textContent = s.temperature;
      $('aa-max-tokens').value = s.maxTokens;
      $('aa-top-p').value = s.topP; $('aa-topp-v').textContent = s.topP;
      $('aa-freq-pen').value = s.frequencyPenalty; $('aa-fp-v').textContent = s.frequencyPenalty;
      $('aa-pres-pen').value = s.presencePenalty; $('aa-pp-v').textContent = s.presencePenalty;
      $('aa-stop').value = s.stop || '';
      $('aa-system-prompt').value = s.systemPrompt || '';
      $('aa-stream').checked = s.stream || false;
      $('aa-auto-detect').checked = s.autoDetect !== false;
      $('aa-auto-fill').checked = s.autoFill !== false;
      $('aa-confirm-fill').checked = s.confirmBeforeFill || false;
      $('aa-only-empty').checked = s.onlyFillEmptyInputs || false;
      $('aa-enable-notify').checked = s.enableNotifications !== false;
      $('aa-delay-time').value = s.delayTime;
      $('aa-parallel-count').value = s.parallelCount;
      $('aa-retry-count').value = s.retryCount;
      $('aa-ctx-before').value = s.contextBeforeCount || 0;
      $('aa-ctx-after').value = s.contextAfterCount || 0;
    }

    saveSettingsFromForm() {
      const $ = (id) => document.getElementById(id);
      this.settings.apiProvider = $('aa-api-provider').value;
      this.settings.apiKey = $('aa-api-key').value;
      this.settings.baseUrl = $('aa-base-url').value;
      this.settings.chatPath = $('aa-chat-path').value;
      this.settings.model = $('aa-model').value;
      this.settings.temperature = parseFloat($('aa-temperature').value);
      this.settings.maxTokens = parseInt($('aa-max-tokens').value);
      this.settings.topP = parseFloat($('aa-top-p').value);
      this.settings.frequencyPenalty = parseFloat($('aa-freq-pen').value);
      this.settings.presencePenalty = parseFloat($('aa-pres-pen').value);
      this.settings.stop = $('aa-stop').value;
      this.settings.systemPrompt = $('aa-system-prompt').value;
      this.settings.stream = $('aa-stream').checked;
      this.settings.autoDetect = $('aa-auto-detect').checked;
      this.settings.autoFill = $('aa-auto-fill').checked;
      this.settings.confirmBeforeFill = $('aa-confirm-fill').checked;
      this.settings.onlyFillEmptyInputs = $('aa-only-empty').checked;
      this.settings.enableNotifications = $('aa-enable-notify').checked;
      this.settings.delayTime = parseInt($('aa-delay-time').value);
      this.settings.parallelCount = parseInt($('aa-parallel-count').value);
      this.settings.retryCount = parseInt($('aa-retry-count').value);
      this.settings.contextBeforeCount = parseInt($('aa-ctx-before').value);
      this.settings.contextAfterCount = parseInt($('aa-ctx-after').value);
      const provider = $('aa-api-provider').value;
      this.settings.isReasoning = ['openai-o1', 'deepseek-reasoner', 'custom-reasoning'].includes(provider);
      this.saveSettings();
    }

    async testAPI() {
      const rd = document.getElementById('aa-api-result'); const btn = document.getElementById('aa-test-api');
      btn.disabled = true; btn.textContent = 'Testing...'; rd.innerHTML = '<div style="color:var(--aa-muted);padding:4px;">Connecting...</div>';
      this.saveSettingsFromForm();
      try {
        const r = await callAPI('1+1=?', this.settings);
        rd.innerHTML = r.success ? `<div style="color:var(--aa-ok,#34d399);padding:6px;font-family:var(--aa-mono);">&#x2713; Connected - model: ${r.model || this.settings.model}</div>` : `<div style="color:var(--aa-err,#f87171);padding:6px;">&#x2717; ${r.error || 'Unknown error'}</div>`;
      } catch (e) { rd.innerHTML = `<div style="color:var(--aa-err,#f87171);padding:6px;">&#x2717; ${e.message}</div>`; }
      btn.disabled = false; btn.textContent = 'Test API';
    }

    updatePanelStats() {
      const $ = (id) => document.getElementById(id);
      if ($('aa-qc')) $('aa-qc').textContent = this.detectedQuestions.length;
      if ($('aa-ac')) $('aa-ac').textContent = this.answeredCount;
      if ($('aa-fc')) $('aa-fc').textContent = this.failedCount;
      if ($('aa-qp-count')) $('aa-qp-count').textContent = this.detectedQuestions.length;

      const statusEl = $('aa-status'); const startBtn = $('aa-start'); const stopBtn = $('aa-stop');
      if (this.isRunning) {
        if (statusEl) { statusEl.textContent = `ANSWERING... ${this.answeredCount + this.failedCount}/${this.detectedQuestions.length}`; statusEl.style.borderColor = 'rgba(6,182,212,.3)'; statusEl.style.color = '#22d3ee'; }
        if (startBtn) startBtn.disabled = true; if (stopBtn) stopBtn.disabled = false;
      } else {
        if (startBtn) startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
        if (this.answeredCount > 0 || this.failedCount > 0) {
          if (statusEl) { statusEl.textContent = `DONE - OK: ${this.answeredCount}, FAIL: ${this.failedCount}`; statusEl.style.borderColor = this.failedCount > 0 ? 'rgba(251,191,36,.3)' : 'rgba(52,211,153,.3)'; statusEl.style.color = this.failedCount > 0 ? '#fbbf24' : '#34d399'; }
        } else {
          if (statusEl) { statusEl.textContent = `READY - ${this.detectedQuestions.length} questions detected`; statusEl.style.borderColor = ''; statusEl.style.color = ''; }
        }
      }
    }

    renderQuestionPreview() {
      const el = document.getElementById('aa-qp'); if (!el) return;
      if (this.detectedQuestions.length === 0) { el.innerHTML = '<div style="color:var(--aa-muted,#94a3b8);font-size:12px;text-align:center;padding:12px 0;">No questions detected</div>'; return; }
      let html = '';
      this.detectedQuestions.forEach((q, i) => {
        const short = q.text.length > 60 ? q.text.substring(0, 60) + '...' : q.text;
        const typeClass = q.type.includes('单选') || q.type.includes('多选') ? 'choice' : q.type.includes('填空') ? 'fill' : 'other';
        html += `<div class="aa-qp-item"><span class="aa-qp-type ${typeClass}">${q.type}</span><span class="aa-qp-text">${i + 1}. ${escapeHtml(short)}</span></div>`;
      });
      el.innerHTML = html;
    }

    loadHistory() {
      const el = document.getElementById('aa-hist-list'); if (!el) return;
      const history = Storage.get('answerHistory', []);
      if (history.length === 0) { el.innerHTML = '<div style="color:var(--aa-muted,#94a3b8);font-size:12px;text-align:center;padding:12px 0;">No answer history</div>'; return; }
      let html = '';
      history.slice().reverse().slice(0, 50).forEach(item => {
        const time = new Date(item.timestamp).toLocaleString();
        const cls = item.success ? 'aa-hist-ok' : 'aa-hist-fail';
        const shortQ = (item.question || '').substring(0, 50);
        html += `<div class="aa-hist-item ${cls}">
          <div class="aa-hist-q">${escapeHtml(shortQ)}${(item.question || '').length > 50 ? '...' : ''}</div>
          <div class="aa-hist-a">ANS: ${escapeHtml(item.answer || 'N/A')}${item.error ? ' <span style="color:var(--aa-err,#f87171);">ERR: ' + escapeHtml(item.error) + '</span>' : ''}</div>
          <div class="aa-hist-meta">${time} <span class="${item.success ? 'aa-hist-ok' : 'aa-hist-fail'}">${item.success ? '成功' : '失败'}</span></div>
        </div>`;
      });
      el.innerHTML = html;
    }

    injectStyles() {
      GM_addStyle(`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@500;700&display=swap');

        @keyframes aa-slideIn { from { transform: translateY(-20px) scale(.97); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
        @keyframes aa-glow { 0%, 100% { box-shadow: 0 0 12px rgba(6,182,212,.15); } 50% { box-shadow: 0 0 20px rgba(6,182,212,.3); } }
        @keyframes aa-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .7; } }
        @keyframes aa-borderShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }

        :root { --aa-accent: #06b6d4; --aa-accent2: #0ea5e9; --aa-bg: rgba(15,23,42,.92); --aa-surface: rgba(30,41,59,.7); --aa-border: rgba(148,163,184,.12); --aa-text: #e2e8f0; --aa-muted: #94a3b8; --aa-ok: #34d399; --aa-err: #f87171; --aa-warn: #fbbf24; --aa-font: 'DM Sans', system-ui, sans-serif; --aa-mono: 'JetBrains Mono', 'Fira Code', monospace; }

        #aa-panel {
          position: fixed; top: 16px; right: 16px; z-index: 2147483647;
          width: 370px; border-radius: 16px; overflow: hidden;
          background: var(--aa-bg); backdrop-filter: blur(24px) saturate(1.4);
          -webkit-backdrop-filter: blur(24px) saturate(1.4);
          border: 1px solid var(--aa-border);
          box-shadow: 0 0 0 1px rgba(6,182,212,.08), 0 8px 40px rgba(0,0,0,.4), 0 0 60px rgba(6,182,212,.06);
          font: 400 13px/1.5 var(--aa-font); color: var(--aa-text);
          animation: aa-slideIn .45s cubic-bezier(.16,1,.3,1);
        }

        .aa-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 16px; cursor: move; user-select: none;
          background: linear-gradient(135deg, rgba(6,182,212,.18), rgba(14,165,233,.12));
          border-bottom: 1px solid var(--aa-border);
          position: relative;
        }
        .aa-header::after {
          content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, var(--aa-accent), transparent);
          opacity: .4;
        }
        .aa-header-title {
          font-weight: 700; font-size: 15px; letter-spacing: .02em;
          background: linear-gradient(135deg, #22d3ee, #38bdf8);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .aa-header-btns { display: flex; gap: 6px; }
        .aa-hdr-btn {
          width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
          background: rgba(148,163,184,.1); color: var(--aa-muted); border: 1px solid rgba(148,163,184,.1);
          border-radius: 8px; cursor: pointer; font-size: 16px; line-height: 1; transition: all .2s;
        }
        .aa-hdr-btn:hover { background: rgba(6,182,212,.15); color: #22d3ee; border-color: rgba(6,182,212,.2); }

        .aa-body { max-height: 540px; overflow-y: auto; }
        .aa-body::-webkit-scrollbar { width: 4px; }
        .aa-body::-webkit-scrollbar-track { background: transparent; }
        .aa-body::-webkit-scrollbar-thumb { background: rgba(148,163,184,.2); border-radius: 4px; }
        .aa-body::-webkit-scrollbar-thumb:hover { background: rgba(148,163,184,.35); }

        /* Tabs */
        .aa-tabs {
          display: flex; border-bottom: 1px solid var(--aa-border);
          background: rgba(15,23,42,.4);
        }
        .aa-tab {
          flex: 1; padding: 10px 0; text-align: center; font-size: 12px; font-weight: 500;
          color: var(--aa-muted); cursor: pointer; border: none; border-bottom: 2px solid transparent;
          background: transparent; transition: all .25s; position: relative;
        }
        .aa-tab:hover { color: var(--aa-accent); background: rgba(6,182,212,.04); }
        .aa-tab.active {
          color: #22d3ee; border-bottom-color: var(--aa-accent); font-weight: 700;
          background: rgba(6,182,212,.06);
        }

        .aa-tab-content { display: none; padding: 14px; }
        .aa-tab-content.active { display: block; animation: aa-fadeIn .2s ease; }
        @keyframes aa-fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

        .aa-section { margin-bottom: 14px; }
        .aa-label { font-size: 11px; color: var(--aa-muted); margin-bottom: 5px; font-weight: 500; letter-spacing: .03em; text-transform: uppercase; }
        .aa-sub-title { font-size: 12px; color: var(--aa-text); font-weight: 700; margin-bottom: 10px; letter-spacing: .02em; }

        /* Stats - dashboard style */
        .aa-stats { display: flex; gap: 8px; margin-bottom: 10px; }
        .aa-stat {
          flex: 1; text-align: center; padding: 10px 4px 8px;
          background: var(--aa-surface); border-radius: 10px;
          border: 1px solid var(--aa-border); position: relative; overflow: hidden;
        }
        .aa-stat::before {
          content: ''; position: absolute; top: 0; left: 20%; right: 20%; height: 2px;
          border-radius: 0 0 4px 4px;
        }
        .aa-stat:first-child::before { background: linear-gradient(90deg, transparent, var(--aa-accent), transparent); }
        .aa-stat:nth-child(2)::before { background: linear-gradient(90deg, transparent, var(--aa-ok), transparent); }
        .aa-stat:nth-child(3)::before { background: linear-gradient(90deg, transparent, var(--aa-err), transparent); }
        .aa-stat-n {
          display: block; font-size: 22px; font-weight: 700;
          font-family: var(--aa-mono); letter-spacing: -.02em;
        }
        .aa-stat:first-child .aa-stat-n { color: #22d3ee; }
        .aa-stat:nth-child(2) .aa-stat-n { color: var(--aa-ok); }
        .aa-stat:nth-child(3) .aa-stat-n { color: var(--aa-err); }
        .aa-stat-l { display: block; font-size: 10px; color: var(--aa-muted); margin-top: 2px; text-transform: uppercase; letter-spacing: .06em; }
        .aa-status {
          padding: 8px 12px; background: var(--aa-surface); border-radius: 8px;
          font-size: 12px; text-align: center; color: var(--aa-muted);
          border: 1px solid var(--aa-border);
          font-family: var(--aa-mono); font-size: 11px;
        }

        /* Buttons */
        .aa-btn-row { display: flex; gap: 8px; margin-bottom: 8px; }
        .aa-btn {
          flex: 1; padding: 9px 14px; border: 1px solid transparent; border-radius: 8px;
          font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s;
          font-family: var(--aa-font); letter-spacing: .01em; position: relative; overflow: hidden;
        }
        .aa-btn:disabled { opacity: .4; cursor: not-allowed; filter: saturate(.3); }
        .aa-btn:active:not(:disabled) { transform: scale(.97); }
        .aa-btn-p {
          background: linear-gradient(135deg, #06b6d4, #0ea5e9); color: #fff;
          box-shadow: 0 2px 12px rgba(6,182,212,.25);
        }
        .aa-btn-p:hover:not(:disabled) { box-shadow: 0 4px 20px rgba(6,182,212,.35); filter: brightness(1.08); }
        .aa-btn-d {
          background: rgba(248,113,113,.12); color: var(--aa-err);
          border-color: rgba(248,113,113,.2);
        }
        .aa-btn-d:hover:not(:disabled) { background: rgba(248,113,113,.2); }
        .aa-btn-ok {
          background: rgba(52,211,153,.12); color: var(--aa-ok);
          border-color: rgba(52,211,153,.2);
        }
        .aa-btn-ok:hover:not(:disabled) { background: rgba(52,211,153,.2); }
        .aa-btn-s {
          background: var(--aa-surface); color: var(--aa-muted);
          border-color: var(--aa-border);
        }
        .aa-btn-s:hover:not(:disabled) { background: rgba(30,41,59,.9); color: var(--aa-text); }
        .aa-btn-sm { padding: 5px 10px; font-size: 12px; flex: none; }

        /* Inputs */
        .aa-input {
          width: 100%; padding: 8px 12px;
          border: 1px solid var(--aa-border); border-radius: 8px;
          font-size: 13px; font-family: var(--aa-font);
          box-sizing: border-box; transition: all .2s;
          background: rgba(15,23,42,.6); color: var(--aa-text);
        }
        .aa-input:focus {
          outline: none; border-color: rgba(6,182,212,.4);
          box-shadow: 0 0 0 3px rgba(6,182,212,.08);
          background: rgba(15,23,42,.8);
        }
        .aa-input::placeholder { color: rgba(148,163,184,.4); }
        select.aa-input { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
        select.aa-input option { background: #1e293b; color: var(--aa-text); }
        .aa-textarea {
          width: 100%; padding: 8px 12px; border: 1px solid var(--aa-border); border-radius: 8px;
          font-size: 12px; font-family: var(--aa-font); box-sizing: border-box;
          resize: vertical; min-height: 70px; background: rgba(15,23,42,.6); color: var(--aa-text);
        }
        .aa-textarea:focus { outline: none; border-color: rgba(6,182,212,.4); box-shadow: 0 0 0 3px rgba(6,182,212,.08); }
        .aa-range { width: 100%; accent-color: var(--aa-accent); height: 4px; }
        .aa-input-row { display: flex; gap: 8px; align-items: center; }
        .aa-input-row .aa-input { flex: 1; }
        .aa-row-2 { display: flex; gap: 8px; }
        .aa-col { flex: 1; min-width: 0; }

        /* Switch */
        .aa-switch { position: relative; display: inline-block; width: 38px; height: 20px; vertical-align: middle; }
        .aa-switch input { opacity: 0; width: 0; height: 0; }
        .aa-slider {
          position: absolute; cursor: pointer; inset: 0;
          background: rgba(100,116,139,.3); border-radius: 20px;
          transition: .3s; border: 1px solid rgba(100,116,139,.2);
        }
        .aa-slider::before {
          content: ''; position: absolute; height: 14px; width: 14px; left: 3px; bottom: 2px;
          background: var(--aa-muted); border-radius: 50%; transition: .3s;
        }
        .aa-switch input:checked + .aa-slider {
          background: rgba(6,182,212,.2); border-color: rgba(6,182,212,.3);
        }
        .aa-switch input:checked + .aa-slider::before {
          transform: translateX(18px); background: #22d3ee;
          box-shadow: 0 0 8px rgba(6,182,212,.4);
        }
        .aa-switch-l { font-size: 12px; color: var(--aa-muted); margin-left: 8px; vertical-align: middle; }
        .aa-switch-row { margin-bottom: 8px; }

        /* Details */
        .aa-details { border: 1px solid var(--aa-border); border-radius: 8px; background: rgba(15,23,42,.3); }
        .aa-details summary {
          padding: 10px 12px; font-size: 12px; color: var(--aa-muted);
          cursor: pointer; font-weight: 500; transition: color .2s;
        }
        .aa-details summary:hover { color: var(--aa-accent); }
        .aa-details-body { padding: 10px 12px; }

        /* Question preview */
        .aa-preview { max-height: 160px; overflow-y: auto; font-size: 12px; }
        .aa-preview::-webkit-scrollbar { width: 3px; }
        .aa-preview::-webkit-scrollbar-thumb { background: rgba(148,163,184,.2); border-radius: 3px; }
        .aa-qp-item {
          padding: 5px 0; border-bottom: 1px solid rgba(148,163,184,.06);
          display: flex; gap: 8px; align-items: baseline; transition: background .15s;
        }
        .aa-qp-item:hover { background: rgba(6,182,212,.03); }
        .aa-qp-text { color: var(--aa-text); }
        .aa-qp-type {
          font-size: 10px; padding: 2px 6px; border-radius: 4px;
          font-weight: 700; flex-shrink: 0; letter-spacing: .03em;
          font-family: var(--aa-mono);
        }
        .aa-qp-type.choice { background: rgba(56,189,248,.12); color: #38bdf8; }
        .aa-qp-type.fill { background: rgba(251,191,36,.12); color: #fbbf24; }
        .aa-qp-type.other { background: rgba(148,163,184,.1); color: var(--aa-muted); }

        /* History */
        .aa-hist-list { max-height: 300px; overflow-y: auto; }
        .aa-hist-list::-webkit-scrollbar { width: 3px; }
        .aa-hist-list::-webkit-scrollbar-thumb { background: rgba(148,163,184,.2); border-radius: 3px; }
        .aa-hist-item { padding: 8px 0; border-bottom: 1px solid rgba(148,163,184,.06); font-size: 12px; }
        .aa-hist-q { color: var(--aa-text); margin-bottom: 3px; }
        .aa-hist-a { color: var(--aa-muted); font-size: 11px; font-family: var(--aa-mono); }
        .aa-hist-meta { color: rgba(148,163,184,.5); font-size: 10px; margin-top: 3px; font-family: var(--aa-mono); }
        .aa-hist-ok { color: var(--aa-ok); font-weight: 700; }
        .aa-hist-fail { color: var(--aa-err); font-weight: 700; }

        /* Light mode override */
        /* Collapsed capsule mode */
        #aa-panel.aa-collapsed {
          width: auto !important; max-height: none !important;
          border-radius: 14px; cursor: pointer;
        }
        #aa-panel.aa-collapsed .aa-header {
          border-bottom: none; padding: 10px 18px;
          justify-content: center;
        }
        #aa-panel.aa-collapsed .aa-header-title {
          font-size: 22px !important; letter-spacing: .08em;
          -webkit-text-fill-color: unset; color: #22d3ee;
          background: none; -webkit-background-clip: unset; background-clip: unset;
        }

        /* Resize handle */
        .aa-resize-handle {
          position: absolute; bottom: 0; right: 0;
          width: 18px; height: 18px; cursor: se-resize; z-index: 10;
        }
        .aa-resize-handle::before {
          content: ''; position: absolute; bottom: 4px; right: 4px;
          width: 8px; height: 8px;
          border-right: 2px solid rgba(148,163,184,.3);
          border-bottom: 2px solid rgba(148,163,184,.3);
        }
        .aa-resize-handle::after {
          content: ''; position: absolute; bottom: 4px; right: 4px;
          width: 4px; height: 4px;
          border-right: 2px solid rgba(148,163,184,.2);
          border-bottom: 2px solid rgba(148,163,184,.2);
        }
        #aa-panel.aa-collapsed .aa-resize-handle { display: none; }

        @media (prefers-color-scheme: light) {
          :root { --aa-bg: rgba(255,255,255,.88); --aa-surface: rgba(241,245,249,.7); --aa-border: rgba(203,213,225,.2); --aa-text: #1e293b; --aa-muted: #64748b; }
          #aa-panel { box-shadow: 0 0 0 1px rgba(6,182,212,.06), 0 8px 40px rgba(0,0,0,.08), 0 0 60px rgba(6,182,212,.03); }
          .aa-input, .aa-textarea { background: rgba(241,245,249,.6); }
          .aa-btn-s { background: rgba(241,245,249,.8); color: #475569; border-color: rgba(203,213,225,.3); }
          .aa-slider { background: rgba(203,213,225,.5); }
          .aa-stat { background: rgba(241,245,249,.6); }
          .aa-qp-type.choice { background: rgba(56,189,248,.1); }
          .aa-qp-type.fill { background: rgba(251,191,36,.1); }
          .aa-qp-type.other { background: rgba(100,116,139,.08); }
          select.aa-input option { background: #fff; color: #1e293b; }
        }
      `);
    }
  }

  // ==================== 启动 ====================
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => new AutoAnswerManager());
  else new AutoAnswerManager();
})();
