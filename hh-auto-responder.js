// ==UserScript==
// @name           HH.ru Custom Script
// @namespace      http://tampermonkey.net/
// @version        2.0
// @description    Автооткликер на HeadHunter — поиски, лимиты, ручные отклики
// @author         Genzor
// @match          https://hh.ru/*
// @match          https://*.hh.ru/*
// @icon           https://www.google.com/s2/favicons?sz=64&domain=hh.ru
// @grant          none
// ==/UserScript==

(function () {
	'use strict';

	// ===== КОНФИГУРАЦИЯ =====
	const CONFIG = {
		RESUME_HASH: '', // ⚠️ ОБЯЗАТЕЛЬНО заполнить хеш резюме!
		COVER_LETTER_TEMPLATE: ``, // ЖЕЛАТЕЛЬНО написать сопроводительное письмо.

		// API endpoints — origin подставляется при инициализации (поддержка nazran.hh.ru и др.)
		VACANCY_API_URL: '',
		VACANCY_POPUP_API: '',
		RESUMES_API: '',
		RESUMES_PAGE_API: '',

		// Настройки
		MAX_RESPONSES_PER_DAY: 200,
		MAX_RESPONSES_PER_SESSION: 50,
		DELAY_BETWEEN_RESPONSES: 3000, // 3 секунды
		DELAY_BETWEEN_PAGES: 5000, // 5 секунд
		MAX_RETRIES: 3,
		RETRY_DELAY: 2000,

		// Настройки фильтрации
		MIN_SALARY: 0, // Минимальная зарплата
		MAX_SALARY: 0, // Максимальная зарплата (0 = без ограничений)
		SKIP_WITHOUT_SALARY: false, // Пропускать вакансии без указания зарплаты
		BLACKLIST_COMPANIES: [], // Список компаний для исключения
		REQUIRED_KEYWORDS: [], // Обязательные ключевые слова в описании
		EXCLUDED_KEYWORDS: [], // Исключающие ключевые слова

		// LocalStorage keys
		FILTER_URL_KEY: 'hh_filter_url',
		SAVED_SEARCHES_KEY: 'hh_saved_searches',
		SELECTED_SEARCH_KEY: 'hh_selected_search_id',
		MANUAL_QUEUE_KEY: 'hh_manual_queue',
		LOG_KEY: 'hh_api_log',
		SENT_RESPONSES_KEY: 'hh_sent_responses',
		STATS_KEY: 'hh_stats',
		SETTINGS_KEY: 'hh_settings',
		CONFIG_KEY: 'hh_config',
	};

	// ===== СОСТОЯНИЕ =====
	const STATE = {
		isRunning: false,
		isPaused: false,
		responsesCount: 0,
		currentPage: 0,
		totalProcessed: 0,
		totalSkipped: 0,
		totalErrors: 0,
		startTime: null,
		pauseTime: null,
		totalPauseTime: 0,
		uiCollapsed: false,
		modalVisible: true,
		modalTab: 'responses',
		currentVacancy: null,
		consecutiveFailures: 0,
		consecutiveAlreadyApplied: 0,
		consecutiveDuplicates: 0,
		autoSaveInterval: null,
		settings: {
			autoFindResume: true,
			showNotifications: true,
			soundEnabled: true,
			darkMode: false,
			enableFilters: true,
			pauseOnError: false,
			autoSaveConfig: true,
			smartDelay: true,
			skipDuplicates: true,
			detailedLogging: true,
			hideUIOnLoad: true,
		},
	};

	// ===== УТИЛИТЫ =====
	const Utils = {
		delay: (ms) => new Promise((res) => setTimeout(res, ms)),

		randomDelay: (min, max) => Utils.delay(Math.random() * (max - min) + min),

		getHhOrigin: () => {
			try {
				if (/(\.|^)hh\.ru$/i.test(window.location.hostname)) {
					return window.location.origin;
				}
			} catch {
				// ignore
			}
			return 'https://hh.ru';
		},

		syncApiEndpoints: () => {
			const origin = Utils.getHhOrigin();
			CONFIG.VACANCY_API_URL = `${origin}/applicant/vacancy_response/popup`;
			CONFIG.VACANCY_POPUP_API = `${origin}/applicant/vacancy_response/popup`;
			CONFIG.RESUMES_API = `${origin}/shards/applicant/resumes`;
			CONFIG.RESUMES_PAGE_API = `${origin}/applicant/resumes`;
		},

		resolveVacancyUrl: (vacancyId) => `${Utils.getHhOrigin()}/vacancy/${vacancyId}`,

		resolveFullUrl: (url) => {
			if (!url) return '';
			if (url.startsWith('http://') || url.startsWith('https://')) return url;
			return `${Utils.getHhOrigin()}${url.startsWith('/') ? '' : '/'}${url}`;
		},

		getSessionLimit: () => {
			const limit = parseInt(CONFIG.MAX_RESPONSES_PER_SESSION, 10);
			if (!limit || limit < 1) return CONFIG.MAX_RESPONSES_PER_DAY;
			return Math.min(limit, CONFIG.MAX_RESPONSES_PER_DAY);
		},

		shouldStopSession: () => {
			return (
				!STATE.isRunning ||
				STATE.responsesCount >= Utils.getSessionLimit() ||
				STATE.responsesCount >= CONFIG.MAX_RESPONSES_PER_DAY
			);
		},

		validateUrl: (url) => {
			try {
				const urlObj = new URL(url);
				return /(^|\.)hh\.ru$/i.test(urlObj.hostname);
			} catch {
				return false;
			}
		},

		// Универсальная логика определения страниц: анализирует URL и путь для определения типа страницы
		// Это позволяет адаптировать поведение скрипта под разные разделы сайта HH.ru
		// Поддерживает: вакансии, поиск, работодатели, резюме и другие страницы
		detectPageType: () => {
			const url = window.location.href;
			const path = window.location.pathname;

			// Главная страница HH.ru
			if (path === '/' || path === '') {
				return 'home';
			}

			// Страница вакансии
			if (path.includes('/vacancy/')) {
				return 'vacancy';
			}

			// Страница поиска вакансий
			if (path.includes('/search/vacancy') || url.includes('search/vacancy')) {
				return 'search';
			}

			// Подборка вакансий вида /vacancies/devops (не то же самое, что /search/vacancy)
			if (/^\/vacancies\/[^/]+\/?$/i.test(path)) {
				return 'collection';
			}

			// Страница работодателя
			if (path.includes('/employer/')) {
				return 'employer';
			}

			// Страница резюме
			if (path.includes('/resume/')) {
				return 'resume';
			}

			// Другие страницы
			return 'other';
		},

		// Fallback-механизмы получения ID вакансии: множественные источники данных
		// Сначала пытаемся извлечь из URL, затем из DOM-элементов страницы
		// Это обеспечивает надежность при разных типах страниц и изменениях разметки
		getVacancyId: () => {
			// Из URL
			const urlMatch = window.location.pathname.match(/\/vacancy\/(\d+)/);
			if (urlMatch) {
				return urlMatch[1];
			}

			// Из элементов страницы (для страницы вакансии)
			const vacancyElement =
				document.querySelector('[data-qa="vacancy-id"]') ||
				document.querySelector('[data-vacancy-id]') ||
				document.querySelector('meta[property="og:url"]');

			if (vacancyElement) {
				const content = vacancyElement.getAttribute('content') || vacancyElement.textContent;
				const idMatch = content.match(/\/vacancy\/(\d+)/);
				if (idMatch) {
					return idMatch[1];
				}
			}

			return null;
		},

		// Fallback-механизмы получения данных вакансии: множественные селекторы для каждого поля
		// HH.ru часто меняет атрибуты data-qa, поэтому используем запасные варианты
		// Это обеспечивает стабильную работу при обновлениях интерфейса сайта
		getCurrentVacancyData: () => {
			const vacancyId = Utils.getVacancyId();
			if (!vacancyId) return null;

			// Название вакансии
			const titleElement =
				document.querySelector('[data-qa="vacancy-title"]') ||
				document.querySelector('h1[data-qa="bloko-header-1"]') ||
				document.querySelector('h1');

			const title = titleElement?.textContent?.trim() || 'Неизвестная вакансия';

			// Компания
			const companyElement =
				document.querySelector('[data-qa="vacancy-company-name"]') ||
				document.querySelector('[data-qa="vacancy-company"] a');

			const company = companyElement?.textContent?.trim() || '';

			// Зарплата
			const salaryElement =
				document.querySelector('[data-qa="vacancy-salary"]') ||
				document.querySelector('[data-qa="vacancy-salary-compensation"]');

			const salary = salaryElement?.textContent?.trim() || '';

			return {
				id: vacancyId,
				title,
				company,
				salary,
				description: '', // Для страницы вакансии описание обычно не нужно для фильтров
				href: window.location.href,
			};
		},

		// Проверки элементов страницы: универсальный поиск кнопки отклика с множественными селекторами
		// HH.ru часто меняет структуру DOM, поэтому используем несколько вариантов селекторов
		// Это fallback-механизм для надежного определения возможности отклика
		hasRespondButton: () => {
			const selectors = [
				'[data-qa="vacancy-response-link"]',
				'[data-qa="vacancy-response"]',
				'[data-qa="vacancy-serp__vacancy_response"]',
				'.vacancy-response__button',
				'button[data-qa*="response"]',
				'a[href*="response"]',
				'.HH-VacancyResponse-Link',
				'[data-qa="respond-button"]',
			];

			return selectors.some((selector) => document.querySelector(selector));
		},

		// Проверки элементов страницы: проверка закрытия вакансии через CSS-селекторы
		// Fallback-механизм для случаев, когда HH.ru меняет структуру разметки
		isVacancyClosed: () => {
			const closedSelectors = [
				'[data-qa="vacancy-closed"]',
				'.vacancy-closed',
				'.HH-VacancyClosed',
				'.vacancy-status_closed',
			];

			// Проверяем наличие элементов "закрыто"
			return closedSelectors.some((selector) => document.querySelector(selector));
		},

		getXsrfToken: () => {
			return document.cookie.match(/_xsrf=([^;]+)/)?.[1] || '';
		},

		getHhtmContext: () => {
			const pageType = Utils.detectPageType();
			const contexts = {
				vacancy: { from: 'vacancy', source: 'vacancy_response' },
				search: { from: 'vacancy_search_list', source: 'vacancy_search_list' },
				home: { from: 'main', source: 'main' },
				employer: { from: 'employer', source: 'employer' },
				resume: { from: 'resume', source: 'resume' },
			};
			return contexts[pageType] || { from: 'vacancy_search_list', source: 'vacancy_search_list' };
		},

		getHhApiHeaders: (xsrf, options = {}) => {
			const ctx = Utils.getHhtmContext();
			const headers = {
				Accept: options.accept || 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				'X-Hhtmfrom': ctx.from,
				'X-Hhtmsource': ctx.source,
			};

			if (xsrf) {
				headers['X-Xsrftoken'] = xsrf;
			}

			return headers;
		},

		formatCompensation: (compensation) => {
			if (!compensation || compensation.noCompensation) return '';

			const { from, to, currencyCode, gross } = compensation;
			const currency = currencyCode === 'RUR' ? '₽' : currencyCode || '';
			const grossLabel = gross ? ' до вычета налогов' : ' на руки';

			if (from && to)
				return `от ${from.toLocaleString('ru-RU')} до ${to.toLocaleString('ru-RU')} ${currency}${grossLabel}`;
			if (from) return `от ${from.toLocaleString('ru-RU')} ${currency}${grossLabel}`;
			if (to) return `до ${to.toLocaleString('ru-RU')} ${currency}${grossLabel}`;
			return '';
		},

		parseVacanciesFromSearchPage: (html) => {
			const markers = [
				'"vacancySearchResult":{"vacancies":',
				'"vacancySearchResult": {"vacancies":',
				'vacancySearchResult":{"vacancies":',
			];

			let markerIndex = -1;
			let marker = '';

			for (const candidate of markers) {
				const idx = html.indexOf(candidate);
				if (idx !== -1) {
					markerIndex = idx;
					marker = candidate;
					break;
				}
			}

			if (markerIndex === -1) {
				return null;
			}

			const jsonStart = html.indexOf('[', markerIndex + marker.length - 1);
			if (jsonStart === -1) return null;

			let depth = 0;
			let jsonEnd = -1;

			for (let i = jsonStart; i < html.length; i++) {
				const char = html[i];
				if (char === '[') depth++;
				else if (char === ']') {
					depth--;
					if (depth === 0) {
						jsonEnd = i;
						break;
					}
				}
			}

			if (jsonEnd === -1) return null;

			try {
				const vacancies = JSON.parse(html.slice(jsonStart, jsonEnd + 1));
				if (!Array.isArray(vacancies) || vacancies.length === 0) return null;

				return vacancies
					.map((vacancy) => {
						const vacancyId = vacancy.vacancyId || vacancy.id;
						if (!vacancyId) return null;

						return {
							id: String(vacancyId),
							title: vacancy.name || vacancy.title || 'Без названия',
							salary: Utils.formatCompensation(vacancy.compensation),
							company: vacancy.company?.name || '',
							description: vacancy.snippet?.requirement || vacancy.snippet?.responsibility || '',
							href:
								vacancy.links?.desktop ||
								vacancy.alternateUrl ||
								Utils.resolveVacancyUrl(vacancyId),
							alreadyApplied: Array.isArray(vacancy.userLabels) && vacancy.userLabels.length > 0,
							hasTest: Boolean(vacancy.userTestPresent),
						};
					})
					.filter(Boolean);
			} catch (error) {
				console.warn('Не удалось распарсить SSR-данные поиска:', error);
				return null;
			}
		},

		convertToSearchUrl: (url) => {
			try {
				const urlObj = new URL(url);

				const collectionMatch = urlObj.pathname.match(/^\/vacancies\/([^/]+)\/?$/i);
				if (collectionMatch) {
					const keyword = decodeURIComponent(collectionMatch[1].replace(/\+/g, ' '));
					const searchUrl = new URL('/search/vacancy', urlObj.origin);
					searchUrl.searchParams.set('text', keyword);
					searchUrl.searchParams.set('search_field', 'name');
					searchUrl.searchParams.set('items_on_page', '20');
					return { url: searchUrl.toString(), converted: true, reason: 'collection' };
				}

				return { url, converted: false };
			} catch {
				return { url, converted: false };
			}
		},

		getUrlHelpMessage: (url) => {
			try {
				const urlObj = new URL(url);
				const path = urlObj.pathname;

				if (/^\/vacancies\/[^/]+\/?$/i.test(path)) {
					return 'Ссылка /vacancies/... — это подборка, а не поиск с фильтрами. Скопируйте URL из адресной строки после поиска: hh.ru/search/vacancy?text=devops&area=...';
				}

				if (/\/vacancy\/\d+/.test(path)) {
					return 'Это ссылка на одну вакансию (/vacancy/123). Для массовых откликов откройте поиск: hh.ru/search/vacancy?text=...';
				}

				if (path === '/' || path === '') {
					return 'Откройте hh.ru/search/vacancy?text=... с нужными фильтрами и запустите оттуда.';
				}
			} catch {
				// ignore
			}

			return 'Нужна ссылка на поиск вакансий: hh.ru/search/vacancy?text=...&area=...';
		},

		normalizeUrl: (url) => {
			try {
				const urlObj = new URL(url);

				const employerMatch = urlObj.pathname.match(/\/employer\/(\d+)/);
				if (employerMatch) {
					const searchUrl = new URL('/search/vacancy', urlObj.origin);
					searchUrl.searchParams.set('employer_id', employerMatch[1]);
					if (!searchUrl.searchParams.has('items_on_page')) {
						searchUrl.searchParams.set('items_on_page', '20');
					}
					return searchUrl.toString();
				}

				if (urlObj.pathname === '/' || urlObj.pathname === '') {
					return null;
				}

				if (!urlObj.pathname.includes('/search/vacancy')) {
					return null;
				}

				if (!urlObj.searchParams.has('items_on_page')) {
					urlObj.searchParams.set('items_on_page', '20');
				}

				return urlObj.toString();
			} catch {
				return null;
			}
		},

		getSearchSignature: (url) => {
			try {
				const urlObj = new URL(url);
				if (!urlObj.pathname.includes('/search/vacancy')) return '';

				const params = new URLSearchParams(urlObj.search);
				params.delete('page');
				params.delete('hhtmFrom');
				params.delete('hhtmFromLabel');
				params.delete('hhtmSource');
				params.delete('hhtmSourceLabel');
				return params.toString();
			} catch {
				return '';
			}
		},

		resolveProcessUrl: (inputUrl = '') => {
			const pageType = Utils.detectPageType();
			const trimmedInput = inputUrl.trim();
			const currentUrl = window.location.href;

			if (pageType === 'vacancy') {
				return currentUrl;
			}

			if (pageType === 'search') {
				if (!trimmedInput) {
					return currentUrl;
				}

				const currentSignature = Utils.getSearchSignature(currentUrl);
				const inputSignature = Utils.getSearchSignature(trimmedInput);

				if (currentSignature && inputSignature && currentSignature !== inputSignature) {
					console.warn(
						'⚠️ URL в поле не совпадает с текущим поиском. Использую текущую страницу:',
						currentUrl,
					);
					UI.showNotification(
						'Используется текущий поиск',
						'URL в поле отличается от открытой страницы — беру текущие фильтры',
						'warning',
						5000,
					);
					return currentUrl;
				}

				return trimmedInput;
			}

			if (pageType === 'employer') {
				return trimmedInput || currentUrl;
			}

			if (pageType === 'collection') {
				return trimmedInput || currentUrl;
			}

			if (!trimmedInput) {
				return null;
			}

			return trimmedInput;
		},

		prepareProcessUrl: (url) => {
			const converted = Utils.convertToSearchUrl(url);
			const normalized = Utils.normalizeUrl(converted.url);

			if (!normalized) {
				return {
					url: null,
					error: Utils.getUrlHelpMessage(url),
					converted: false,
				};
			}

			if (!normalized.includes('/search/vacancy')) {
				return {
					url: null,
					error: Utils.getUrlHelpMessage(url),
					converted: false,
				};
			}

			if (converted.converted) {
				console.warn('⚠️ Ссылка подборки преобразована в поиск:', url, '→', normalized);
			}

			return {
				url: normalized,
				error: null,
				converted: converted.converted,
				originalUrl: converted.converted ? url : null,
			};
		},

		formatTime: (ms) => {
			const seconds = Math.floor(ms / 1000);
			const minutes = Math.floor(seconds / 60);
			const hours = Math.floor(minutes / 60);

			if (hours > 0) {
				return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60)
					.toString()
					.padStart(2, '0')}`;
			}
			return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
		},

		formatNumber: (num) => {
			return new Intl.NumberFormat('ru-RU').format(num);
		},

		playNotificationSound: () => {
			if (!STATE.settings.soundEnabled) return;

			try {
				const audio = new Audio(
					'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT',
				);
				audio.volume = 0.3;
				audio.play();
			} catch (e) {
				console.log('Не удалось воспроизвести звук');
			}
		},

		getFormattedStats: () => {
			const stats = Logger.getStats();
			const sentCount = Responses.getSentCount();
			const totalRunTime = stats.runningTime ? stats.runningTime - STATE.totalPauseTime : 0;
			const runningTime = totalRunTime > 0 ? Math.floor(totalRunTime / 1000) : 0;

			return {
				totalSent: stats.totalSent || 0,
				totalProcessed: stats.totalProcessed || 0,
				totalSkipped: stats.totalSkipped || 0,
				totalErrors: stats.totalErrors || 0,
				allTimeSent: sentCount,
				runningTime: Utils.formatTime(runningTime * 1000),
				successRate:
					stats.totalProcessed > 0 ? Math.round((stats.totalSent / stats.totalProcessed) * 100) : 0,
				avgResponseTime: stats.totalSent > 0 ? Math.round(runningTime / stats.totalSent) : 0,
			};
		},

		parseSalary: (salaryText) => {
			if (!salaryText) return null;

			const cleanText = salaryText.replace(/\s/g, '').replace(/₽|руб|rub/gi, '');
			const numbers = cleanText.match(/\d+/g);

			if (!numbers) return null;

			if (cleanText.includes('от')) {
				return { from: parseInt(numbers[0]), to: null };
			} else if (cleanText.includes('до')) {
				return { from: null, to: parseInt(numbers[0]) };
			} else if (numbers.length >= 2) {
				return { from: parseInt(numbers[0]), to: parseInt(numbers[1]) };
			} else {
				return { from: parseInt(numbers[0]), to: parseInt(numbers[0]) };
			}
		},

		saveConfig: () => {
			if (!STATE.settings.autoSaveConfig) return;

			const configToSave = {
				...CONFIG,
				settings: STATE.settings,
			};
			localStorage.setItem(CONFIG.CONFIG_KEY, JSON.stringify(configToSave));
		},

		loadConfig: () => {
			try {
				const saved = localStorage.getItem(CONFIG.CONFIG_KEY);
				if (saved) {
					const savedConfig = JSON.parse(saved);
					Object.assign(CONFIG, savedConfig);
					if (savedConfig.settings) {
						Object.assign(STATE.settings, savedConfig.settings);
					}
				}
			} catch (error) {
				console.error('Ошибка загрузки конфигурации:', error);
			}
		},

		debounce: (func, wait) => {
			let timeout;
			return function executedFunction(...args) {
				const later = () => {
					clearTimeout(timeout);
					func(...args);
				};
				clearTimeout(timeout);
				timeout = setTimeout(later, wait);
			};
		},

		throttle: (func, limit) => {
			let inThrottle;
			return function () {
				const args = arguments;
				const context = this;
				if (!inThrottle) {
					func.apply(context, args);
					inThrottle = true;
					setTimeout(() => (inThrottle = false), limit);
				}
			};
		},

		sanitizeHtml: (str) => {
			const div = document.createElement('div');
			div.textContent = str;
			return div.innerHTML;
		},

		getSmartDelay: () => {
			if (!STATE.settings.smartDelay) {
				return CONFIG.DELAY_BETWEEN_RESPONSES;
			}

			// Адаптивная задержка на основе времени суток и активности
			const hour = new Date().getHours();
			let multiplier = 1;

			// Ночные часы (23:00-06:59) - больше задержка
			if (hour >= 23 || hour < 7) {
				multiplier = 1.5;
			}
			// Рабочие часы (07:00-18:59) - меньше задержка
			else if (hour >= 7 && hour <= 18) {
				multiplier = 0.8;
			}
			// Вечерние часы (19:00-22:59) - базовая задержка
			else {
				multiplier = 1;
			}

			return Math.floor(CONFIG.DELAY_BETWEEN_RESPONSES * multiplier);
		},
	};

	// ===== ФИЛЬТРЫ =====
	const Filters = {
		checkSalary: (salary) => {
			if (!STATE.settings.enableFilters) return { passed: true };

			if (!salary && CONFIG.SKIP_WITHOUT_SALARY) {
				return { passed: false, reason: 'Нет зарплаты' };
			}

			if (!salary) return { passed: true };

			const parsedSalary = Utils.parseSalary(salary);
			if (!parsedSalary) return { passed: true };

			if (CONFIG.MIN_SALARY > 0) {
				// Проверяем MIN_SALARY: вакансия проходит, если максимальная зарплата >= MIN_SALARY
				// Если указан диапазон (from-to), проверяем максимальное значение (to)
				// Если указано только "от" (from), проверяем from
				// Если указано только "до" (to), проверяем to
				const maxSalary = parsedSalary.to || parsedSalary.from;
				if (maxSalary && maxSalary < CONFIG.MIN_SALARY) {
					return {
						passed: false,
						reason: `Зарплата ниже ${Utils.formatNumber(CONFIG.MIN_SALARY)}`,
					};
				}
			}

			if (CONFIG.MAX_SALARY > 0) {
				// Проверяем MAX_SALARY: вакансия проходит, если минимальная зарплата <= MAX_SALARY
				// Если указан диапазон (from-to), проверяем минимальное значение (from)
				// Если указано только "от" (from), проверяем from
				// Если указано только "до" (to), проверяем to
				const minSalary = parsedSalary.from || parsedSalary.to;
				if (minSalary && minSalary > CONFIG.MAX_SALARY) {
					return {
						passed: false,
						reason: `Зарплата выше ${Utils.formatNumber(CONFIG.MAX_SALARY)}`,
					};
				}
			}

			return { passed: true };
		},

		checkCompany: (companyName) => {
			if (!STATE.settings.enableFilters || !companyName) return { passed: true };

			const isBlacklisted = CONFIG.BLACKLIST_COMPANIES.some((blacklisted) =>
				companyName.toLowerCase().includes(blacklisted.toLowerCase()),
			);

			if (isBlacklisted) {
				return { passed: false, reason: 'Компания в черном списке' };
			}

			return { passed: true };
		},

		checkKeywords: (title, description = '') => {
			if (!STATE.settings.enableFilters) return { passed: true };

			const text = (title + ' ' + description).toLowerCase();

			// Проверяем обязательные ключевые слова
			if (CONFIG.REQUIRED_KEYWORDS.length > 0) {
				const hasRequired = CONFIG.REQUIRED_KEYWORDS.some((keyword) =>
					text.includes(keyword.toLowerCase()),
				);
				if (!hasRequired) {
					return {
						passed: false,
						reason: `Нет обязательных слов: ${CONFIG.REQUIRED_KEYWORDS.join(', ')}`,
					};
				}
			}

			// Проверяем исключающие ключевые слова
			if (CONFIG.EXCLUDED_KEYWORDS.length > 0) {
				const hasExcluded = CONFIG.EXCLUDED_KEYWORDS.some((keyword) =>
					text.includes(keyword.toLowerCase()),
				);
				if (hasExcluded) {
					const excludedWord = CONFIG.EXCLUDED_KEYWORDS.find((keyword) =>
						text.includes(keyword.toLowerCase()),
					);
					return { passed: false, reason: `Содержит исключенное слово: ${excludedWord}` };
				}
			}

			return { passed: true };
		},

		shouldSkipVacancy: (vacancyData) => {
			const checks = [
				Filters.checkSalary(vacancyData.salary),
				Filters.checkCompany(vacancyData.company),
				Filters.checkKeywords(vacancyData.title, vacancyData.description),
			];

			const failedChecks = checks.filter((check) => !check.passed);

			if (failedChecks.length > 0) {
				return {
					skip: true,
					reasons: failedChecks.map((check) => check.reason),
				};
			}

			return { skip: false };
		},
	};

	// ===== ЛОГИРОВАНИЕ И СТАТИСТИКА =====
	const Logger = {
		saveLog: (entry) => {
			const log = JSON.parse(localStorage.getItem(CONFIG.LOG_KEY) || '[]');

			// Добавляем дополнительную информацию
			const enhancedEntry = {
				...entry,
				timestamp: Date.now(),
				userAgent: navigator.userAgent.substring(0, 50),
				url: window.location.href,
			};

			log.push(enhancedEntry);

			// Ограничиваем размер лога
			if (log.length > 500) {
				log.splice(0, log.length - 500);
			}

			localStorage.setItem(CONFIG.LOG_KEY, JSON.stringify(log));
			UI.updateModal(enhancedEntry);
			Logger.updateStats();

			// Воспроизводим звук при успешном отклике
			if (entry.success) {
				Utils.playNotificationSound();
			}
		},

		updateStats: () => {
			const currentTime = Date.now();
			const runningTime = STATE.startTime ? currentTime - STATE.startTime : 0;

			const stats = {
				totalSent: STATE.responsesCount,
				totalProcessed: STATE.totalProcessed,
				totalSkipped: STATE.totalSkipped,
				totalErrors: STATE.totalErrors,
				lastRun: new Date().toISOString(),
				runningTime: runningTime,
				currentPage: STATE.currentPage,
				isPaused: STATE.isPaused,
			};
			localStorage.setItem(CONFIG.STATS_KEY, JSON.stringify(stats));
		},

		getStats: () => {
			return JSON.parse(localStorage.getItem(CONFIG.STATS_KEY) || '{}');
		},

		getLogs: () => {
			return JSON.parse(localStorage.getItem(CONFIG.LOG_KEY) || '[]');
		},

		exportLogs: () => {
			const log = Logger.getLogs();
			const stats = Logger.getStats();

			const exportData = {
				timestamp: new Date().toISOString(),
				version: '3.0',
				stats: stats,
				config: CONFIG,
				settings: STATE.settings,
				logs: log,
			};

			const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `hh_responses_${new Date().toISOString().split('T')[0]}.json`;
			a.click();
			URL.revokeObjectURL(url);
		},

		clearLogs: () => {
			if (confirm('Вы уверены, что хотите очистить все логи и статистику?')) {
				localStorage.removeItem(CONFIG.LOG_KEY);
				localStorage.removeItem(CONFIG.SENT_RESPONSES_KEY);
				localStorage.removeItem(CONFIG.STATS_KEY);
				UI.updateModal();
				UI.showNotification('Очищено', 'Все логи и статистика удалены', 'success');
			}
		},

		getErrorStats: () => {
			const logs = Logger.getLogs();
			const errors = logs.filter((log) => !log.success);
			const errorTypes = {};

			errors.forEach((error) => {
				const message = error.message || 'Неизвестная ошибка';
				errorTypes[message] = (errorTypes[message] || 0) + 1;
			});

			return errorTypes;
		},
	};

	// ===== УПРАВЛЕНИЕ ОТКЛИКАМИ =====
	const Responses = {
		isAlreadyResponded: (vacancyId) => {
			if (!vacancyId) return false;
			const sentResponses = JSON.parse(localStorage.getItem(CONFIG.SENT_RESPONSES_KEY) || '[]');
			return sentResponses.includes(vacancyId);
		},

		markAsResponded: (vacancyId) => {
			if (!vacancyId) return;
			const sentResponses = JSON.parse(localStorage.getItem(CONFIG.SENT_RESPONSES_KEY) || '[]');
			if (!sentResponses.includes(vacancyId)) {
				sentResponses.push(vacancyId);
				// Ограничиваем размер массива
				if (sentResponses.length > 10000) {
					sentResponses.splice(0, sentResponses.length - 10000);
				}
				localStorage.setItem(CONFIG.SENT_RESPONSES_KEY, JSON.stringify(sentResponses));
			}
		},

		getSentCount: () => {
			const sentResponses = JSON.parse(localStorage.getItem(CONFIG.SENT_RESPONSES_KEY) || '[]');
			return sentResponses.length;
		},

		clearSentResponses: () => {
			if (confirm('Вы уверены, что хотите очистить список отправленных откликов?')) {
				localStorage.removeItem(CONFIG.SENT_RESPONSES_KEY);
				UI.showNotification('Очищено', 'Список отправленных откликов очищен', 'success');
			}
		},

		getSentToday: () => {
			// Используем логи для подсчета, так как они содержат timestamp
			// Но также проверяем SENT_RESPONSES_KEY для надежности
			const logs = Logger.getLogs();
			const today = new Date().toDateString();
			const fromLogs = logs.filter(
				(log) => log.success && new Date(log.time).toDateString() === today,
			).length;

			// Дополнительная проверка: если логи очищены, используем общий счетчик
			// Но это менее точно, так как SENT_RESPONSES_KEY не содержит дату
			return fromLogs;
		},
	};

	const SEARCH_PRESETS = [
		{
			id: 'preset-devops',
			name: 'DevOps · Москва',
			url: '/search/vacancy?text=devops&area=1&search_field=name&items_on_page=20',
			isPreset: true,
		},
		{
			id: 'preset-python-remote',
			name: 'Python · удалёнка',
			url: '/search/vacancy?text=python&area=113&schedule=remote&search_field=name&items_on_page=20',
			isPreset: true,
		},
		{
			id: 'preset-backend',
			name: 'Backend · Россия',
			url: '/search/vacancy?text=backend&area=113&search_field=name&items_on_page=20',
			isPreset: true,
		},
	];

	const SavedSearches = {
		getCustom: () => {
			try {
				const items = JSON.parse(localStorage.getItem(CONFIG.SAVED_SEARCHES_KEY) || '[]');
				return Array.isArray(items) ? items : [];
			} catch {
				return [];
			}
		},

		saveCustom: (items) => {
			localStorage.setItem(CONFIG.SAVED_SEARCHES_KEY, JSON.stringify(items));
		},

		getSelectableOptions: () => {
			const custom = SavedSearches.getCustom();
			if (custom.length > 0) return custom;
			return SEARCH_PRESETS;
		},

		getSelectedId: () => localStorage.getItem(CONFIG.SELECTED_SEARCH_KEY) || '',

		setSelectedId: (id) => {
			if (id) localStorage.setItem(CONFIG.SELECTED_SEARCH_KEY, id);
			else localStorage.removeItem(CONFIG.SELECTED_SEARCH_KEY);
		},

		findById: (id) => {
			if (!id || id === '__current__') return null;
			return (
				SavedSearches.getCustom().find((item) => item.id === id) ||
				SEARCH_PRESETS.find((item) => item.id === id)
			);
		},

		getUrlById: (id) => {
			if (id === '__current__') return window.location.href;
			const item = SavedSearches.findById(id);
			return item ? Utils.resolveFullUrl(item.url) : '';
		},

		add: (name, url) => {
			const trimmedName = name?.trim();
			const trimmedUrl = url?.trim();
			if (!trimmedName || !trimmedUrl) return null;

			const items = SavedSearches.getCustom();
			const entry = {
				id: `search-${Date.now()}`,
				name: trimmedName,
				url: trimmedUrl.startsWith('http') ? trimmedUrl : Utils.resolveFullUrl(trimmedUrl),
				isPreset: false,
			};
			items.unshift(entry);
			SavedSearches.saveCustom(items);
			SavedSearches.setSelectedId(entry.id);
			return entry;
		},

		remove: (id) => {
			const items = SavedSearches.getCustom().filter((item) => item.id !== id);
			SavedSearches.saveCustom(items);
			if (SavedSearches.getSelectedId() === id) {
				const next = items[0]?.id || SEARCH_PRESETS[0]?.id || '__current__';
				SavedSearches.setSelectedId(next);
			}
		},

		suggestNameFromUrl: (url) => {
			try {
				const urlObj = new URL(url);
				const text = urlObj.searchParams.get('text');
				const area = urlObj.searchParams.get('area');
				if (text && area) return `${text} · area ${area}`;
				if (text) return text;
			} catch {
				// ignore
			}
			return 'Мой поиск';
		},

		resolveActiveUrl: (preferredId) => {
			const pageType = Utils.detectPageType();
			const selectEl = document.getElementById('hh-search-select');
			const selectedId = preferredId || selectEl?.value || SavedSearches.getSelectedId();

			if (selectedId === '__current__' || (!selectedId && pageType === 'search')) {
				return window.location.href;
			}

			if (selectedId) {
				const url = SavedSearches.getUrlById(selectedId);
				if (url) return url;
			}

			return Utils.resolveProcessUrl('');
		},
	};

	const ManualQueue = {
		getAll: () => {
			try {
				const items = JSON.parse(localStorage.getItem(CONFIG.MANUAL_QUEUE_KEY) || '[]');
				return Array.isArray(items) ? items : [];
			} catch {
				return [];
			}
		},

		save: (items) => {
			localStorage.setItem(CONFIG.MANUAL_QUEUE_KEY, JSON.stringify(items));
		},

		add: (entry) => {
			if (!entry?.id) return;
			const items = ManualQueue.getAll();
			if (items.some((item) => item.id === entry.id)) return;

			items.unshift({
				id: String(entry.id),
				title: entry.title || 'Вакансия',
				reason: entry.reason || 'Требуется ручной отклик',
				href: entry.href || Utils.resolveVacancyUrl(entry.id),
				time: entry.time || new Date().toISOString(),
			});

			if (items.length > 200) items.length = 200;
			ManualQueue.save(items);
			UI.updateManualTab?.();
		},

		remove: (id) => {
			ManualQueue.save(ManualQueue.getAll().filter((item) => item.id !== id));
			UI.updateManualTab?.();
		},

		clear: () => {
			if (confirm('Очистить список вакансий для ручного отклика?')) {
				localStorage.removeItem(CONFIG.MANUAL_QUEUE_KEY);
				UI.updateManualTab?.();
				UI.showNotification('Очищено', 'Список ручных откликов пуст', 'success');
			}
		},
	};

	// ===== UI МОДУЛЬ =====
	const UI = {
		createModal: () => {
			let modal = document.getElementById('hh-api-modal');
			if (!modal) {
				modal = document.createElement('div');
				modal.id = 'hh-api-modal';
				modal.style.cssText = `
					position: fixed;
					bottom: 140px;
					right: 20px;
					width: 450px;
					max-height: 600px;
					overflow-y: auto;
					background: rgba(255, 255, 255, 0.98);
					border: 1px solid #e5e7eb;
					border-radius: 16px;
					box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
					z-index: 10001;
					font-family: system-ui, -apple-system, sans-serif;
					padding: 24px;
					display: ${STATE.modalVisible ? 'block' : 'none'};
					backdrop-filter: blur(16px);
					transition: all 0.3s ease;
				`;

				modal.innerHTML = `
					<style>
						#hh-api-modal {
							scrollbar-width: thin;
							scrollbar-color: #cbd5e0 #f7fafc;
						}
						#hh-api-modal::-webkit-scrollbar {
							width: 6px;
						}
						#hh-api-modal::-webkit-scrollbar-track {
							background: #f7fafc;
							border-radius: 3px;
						}
						#hh-api-modal::-webkit-scrollbar-thumb {
							background: #cbd5e0;
							border-radius: 3px;
						}
						.modal-header {
							position: relative;
							display: flex;
							justify-content: space-between;
							align-items: center;
							margin-bottom: 20px;
							padding-bottom: 16px;
							border-bottom: 2px solid #f1f5f9;
						}
						.modal-title {
							font-size: 20px;
							font-weight: 700;
							color: #1e293b;
							margin: 0;
							display: flex;
							align-items: center;
							gap: 8px;
						}
						.modal-close {
							position: absolute;
							top: 20px;
							right: 20px;
							background: rgba(255, 255, 255, 0.95);
							border: 1px solid #e5e7eb;
							font-size: 24px;
							cursor: pointer;
							color: #64748b;
							padding: 8px;
							border-radius: 8px;
							transition: all 0.2s ease;
							line-height: 1;
							z-index: 10002;
							box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
						}
						.modal-close:hover {
							background: #f1f5f9;
							color: #1e293b;
						}
						.log-list {
							list-style: none;
							padding: 0;
							margin: 0;
						}
						.log-item {
							display: flex;
							align-items: flex-start;
							padding: 16px 0;
							border-bottom: 1px solid #f1f5f9;
							transition: all 0.2s ease;
						}
						.log-item:hover {
							background: #f8fafc;
							margin: 0 -12px;
							padding: 16px 12px;
							border-radius: 12px;
						}
						.log-item:last-child {
							border-bottom: none;
						}
						.log-link {
							color: #1e40af;
							text-decoration: none;
							font-size: 14px;
							flex: 1;
							transition: color 0.2s ease;
							line-height: 1.5;
							font-weight: 500;
						}
						.log-link:hover {
							color: #1d4ed8;
						}
						.log-symbol {
							font-size: 20px;
							margin-right: 12px;
							margin-top: 2px;
						}
						.log-time {
							font-size: 11px;
							color: #64748b;
							margin-left: 12px;
							white-space: nowrap;
							font-weight: 500;
						}
						.stats-container {
							margin-top: 20px;
							padding: 16px;
							background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
							border-radius: 16px;
							font-size: 13px;
							color: #475569;
							border: 1px solid #e2e8f0;
						}
						.stats-title {
							font-weight: 700;
							margin-bottom: 12px;
							color: #1e293b;
							font-size: 16px;
						}
						.stats-grid {
							display: grid;
							grid-template-columns: 1fr 1fr;
							gap: 12px;
							margin-top: 12px;
						}
						.stats-item {
							display: flex;
							justify-content: space-between;
							align-items: center;
							padding: 8px 0;
						}
						.stats-label {
							font-weight: 600;
							color: #374151;
						}
						.stats-value {
							font-weight: 700;
							color: #1e40af;
						}
						.modal-progress {
							margin-top: 6px;
							font-size: 12px;
							color: #64748b;
							font-weight: 500;
						}
						.modal-tabs {
							display: flex;
							gap: 8px;
							margin-bottom: 16px;
							border-bottom: 1px solid #e2e8f0;
							padding-bottom: 8px;
						}
						.modal-tab {
							flex: 1;
							border: none;
							background: transparent;
							padding: 10px 12px;
							border-radius: 10px;
							font-size: 13px;
							font-weight: 600;
							color: #64748b;
							cursor: pointer;
							transition: all 0.2s ease;
						}
						.modal-tab.active {
							background: #eff6ff;
							color: #1d4ed8;
						}
						.modal-badge {
							display: inline-flex;
							min-width: 18px;
							height: 18px;
							padding: 0 6px;
							border-radius: 999px;
							background: #e2e8f0;
							color: #475569;
							font-size: 11px;
							align-items: center;
							justify-content: center;
							margin-left: 4px;
						}
						.modal-tab.active .modal-badge {
							background: #dbeafe;
							color: #1d4ed8;
						}
						.manual-hint {
							font-size: 13px;
							color: #64748b;
							margin-bottom: 12px;
							line-height: 1.5;
						}
						.manual-actions {
							display: flex;
							gap: 8px;
							margin-left: auto;
						}
						.manual-remove {
							border: none;
							background: #fee2e2;
							color: #b91c1c;
							border-radius: 8px;
							padding: 4px 8px;
							cursor: pointer;
							font-size: 12px;
						}
						@media (max-width: 600px) {
							#hh-api-modal {
								width: 90%;
								right: 5%;
								bottom: 120px;
							}
						}
					</style>
					<div class="modal-header">
						<div>
							<h3 class="modal-title">📤 Отклики</h3>
							<div id="hh-modal-progress" class="modal-progress" style="display:none;"></div>
						</div>
						<button class="modal-close">×</button>
					</div>
					<div class="modal-tabs">
						<button type="button" class="modal-tab active" data-tab="responses">История</button>
						<button type="button" class="modal-tab" data-tab="manual">Вручную <span id="hh-manual-badge" class="modal-badge">0</span></button>
					</div>
					<div id="hh-tab-responses" class="modal-tab-panel">
						<ul class="log-list"></ul>
						<div class="stats-container">
							<div class="stats-title">📊 Статистика</div>
							<div class="stats-grid"></div>
						</div>
					</div>
					<div id="hh-tab-manual" class="modal-tab-panel" style="display:none;">
						<div class="manual-hint">Вакансии с тестом или обязательным письмом — откликнитесь сами.</div>
						<ul id="hh-manual-list" class="log-list"></ul>
						<button type="button" id="hh-manual-clear" class="hh-btn-ghost" style="width:100%;margin-top:12px;">Очистить список</button>
					</div>
				`;

				const closeBtn = modal.querySelector('.modal-close');
				closeBtn.onclick = () => {
					STATE.modalVisible = false;
					modal.style.display = 'none';
				};

				modal.querySelectorAll('.modal-tab').forEach((tab) => {
					tab.onclick = () => UI.switchModalTab(tab.dataset.tab);
				});

				const manualClearBtn = modal.querySelector('#hh-manual-clear');
				if (manualClearBtn) manualClearBtn.onclick = () => ManualQueue.clear();

				document.body.appendChild(modal);
			} else {
				modal.style.display = STATE.modalVisible ? 'block' : 'none';
			}
			return modal;
		},

		switchModalTab: (tabName) => {
			STATE.modalTab = tabName;
			const modal = document.getElementById('hh-api-modal');
			if (!modal) return;

			modal.querySelectorAll('.modal-tab').forEach((tab) => {
				tab.classList.toggle('active', tab.dataset.tab === tabName);
			});

			const responsesPanel = modal.querySelector('#hh-tab-responses');
			const manualPanel = modal.querySelector('#hh-tab-manual');
			if (responsesPanel) responsesPanel.style.display = tabName === 'responses' ? 'block' : 'none';
			if (manualPanel) manualPanel.style.display = tabName === 'manual' ? 'block' : 'none';

			if (tabName === 'manual') UI.updateManualTab();
		},

		updateManualTab: () => {
			const modal = document.getElementById('hh-api-modal');
			if (!modal) return;

			const list = modal.querySelector('#hh-manual-list');
			const badge = modal.querySelector('#hh-manual-badge');
			const items = ManualQueue.getAll();

			if (badge) badge.textContent = String(items.length);
			if (!list) return;

			list.innerHTML = '';
			if (items.length === 0) {
				const empty = document.createElement('li');
				empty.className = 'log-item';
				empty.style.cssText = 'justify-content:center;color:#94a3b8;';
				empty.textContent = 'Пока пусто — сюда попадут вакансии с тестами';
				list.appendChild(empty);
				return;
			}

			items.forEach((item) => {
				const li = document.createElement('li');
				li.className = 'log-item';

				const symbol = document.createElement('span');
				symbol.className = 'log-symbol';
				symbol.textContent = '📝';

				const link = document.createElement('a');
				link.className = 'log-link';
				link.href = item.href;
				link.target = '_blank';
				link.textContent = `${item.title} (${item.reason})`;

				const actions = document.createElement('div');
				actions.className = 'manual-actions';

				const time = document.createElement('span');
				time.className = 'log-time';
				time.textContent = new Date(item.time).toLocaleDateString();

				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'manual-remove';
				removeBtn.textContent = '✕';
				removeBtn.onclick = () => ManualQueue.remove(item.id);

				actions.appendChild(time);
				actions.appendChild(removeBtn);
				li.appendChild(symbol);
				li.appendChild(link);
				li.appendChild(actions);
				list.appendChild(li);
			});
		},

		updateRunProgress: () => {
			const progress = document.getElementById('hh-modal-progress');
			if (!progress) return;

			if (!STATE.isRunning) {
				progress.style.display = 'none';
				return;
			}

			progress.style.display = 'block';
			const searchName =
				document.getElementById('hh-search-select')?.selectedOptions?.[0]?.textContent?.trim() ||
				'поиск';
			progress.textContent = `${STATE.responsesCount} / ${Utils.getSessionLimit()} · ${searchName}${
				STATE.currentVacancy ? ` · ${STATE.currentVacancy}` : ''
			}`;
		},

		updateModal: (entry) => {
			const modal = UI.createModal();
			const list = modal.querySelector('#hh-tab-responses .log-list');
			const statsGrid = modal.querySelector('.stats-grid');

			if (!list) return;

			// Обновляем позицию крестика при обновлении модального окна
			if (modal._updateClosePosition) {
				setTimeout(() => modal._updateClosePosition(), 0);
			}

			// Добавляем новую запись
			try {
				if (entry) {
					const li = document.createElement('li');
					li.className = 'log-item';

					const symbol = entry.success ? '✅' : '❌';
					const a = document.createElement('a');
					a.className = 'log-link';
					a.href = Utils.resolveVacancyUrl(entry.id);
					a.textContent = entry.title + (entry.message ? ` (${entry.message})` : '');
					a.target = '_blank';

					const timeSpan = document.createElement('span');
					timeSpan.className = 'log-time';
					timeSpan.textContent = new Date(entry.time).toLocaleTimeString();

					const symbolSpan = document.createElement('span');
					symbolSpan.className = 'log-symbol';
					symbolSpan.textContent = symbol;

					li.appendChild(symbolSpan);
					li.appendChild(a);
					li.appendChild(timeSpan);
					list.insertBefore(li, list.firstChild);

					// Ограничиваем количество записей
					while (list.children.length > 15) {
						list.removeChild(list.lastChild);
					}
				}
			} catch (error) {
				console.error('Ошибка добавления записи в лог:', error);
			}

			// Обновляем статистику
			try {
				if (statsGrid) {
					const formattedStats = Utils.getFormattedStats();

					statsGrid.innerHTML = `
						<div class="stats-item">
							<span class="stats-label">Отправлено:</span>
							<span class="stats-value">${formattedStats.totalSent}</span>
						</div>
						<div class="stats-item">
							<span class="stats-label">Обработано:</span>
							<span class="stats-value">${formattedStats.totalProcessed}</span>
						</div>
						<div class="stats-item">
							<span class="stats-label">Пропущено:</span>
							<span class="stats-value">${formattedStats.totalSkipped}</span>
						</div>
						<div class="stats-item">
							<span class="stats-label">Ошибки:</span>
							<span class="stats-value">${formattedStats.totalErrors}</span>
						</div>
						<div class="stats-item">
							<span class="stats-label">Всего отправлено:</span>
							<span class="stats-value">${Utils.formatNumber(formattedStats.allTimeSent)}</span>
						</div>
						<div class="stats-item">
							<span class="stats-label">Успешность:</span>
							<span class="stats-value">${formattedStats.successRate}%</span>
						</div>
						<div class="stats-item" style="grid-column: 1 / -1;">
							<span class="stats-label">Время работы:</span>
							<span class="stats-value">${formattedStats.runningTime}</span>
						</div>
						<div class="stats-item" style="grid-column: 1 / -1;">
							<span class="stats-label">Лимит за запуск:</span>
							<span class="stats-value">${STATE.responsesCount} / ${Utils.getSessionLimit()}</span>
						</div>
						<div class="stats-item" style="grid-column: 1 / -1;">
							<span class="stats-label">Сегодня отправлено:</span>
							<span class="stats-value">${Responses.getSentToday()}</span>
						</div>
					`;
				}
			} catch (error) {
				console.error('Ошибка обновления статистики:', error);
			}

			UI.updateManualTab();
			UI.updateRunProgress();
		},

		showNotification: (title, message, type = 'info', duration = 4000) => {
			if (!STATE.settings.showNotifications) return;

			const notification = document.createElement('div');
			const colors = {
				success: '#10b981',
				error: '#ef4444',
				warning: '#f59e0b',
				info: '#3b82f6',
			};

			notification.style.cssText = `
				position: fixed;
				top: 20px;
				right: 20px;
				background: ${colors[type] || colors.info};
				color: white;
				padding: 16px 20px;
				border-radius: 12px;
				box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
				z-index: 10004;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 14px;
				max-width: 350px;
				min-width: 250px;
				transform: translateX(400px);
				transition: transform 0.3s ease;
				cursor: pointer;
			`;

			notification.innerHTML = `
				<div style="font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
					${type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️'}
					${Utils.sanitizeHtml(title)}
				</div>
				<div style="opacity: 0.9; line-height: 1.4;">${Utils.sanitizeHtml(message)}</div>
			`;

			// Закрытие по клику
			notification.onclick = () => {
				notification.style.transform = 'translateX(400px)';
				setTimeout(() => {
					if (document.body.contains(notification)) {
						document.body.removeChild(notification);
					}
				}, 300);
			};

			document.body.appendChild(notification);

			// Анимация появления
			setTimeout(() => {
				notification.style.transform = 'translateX(0)';
			}, 100);

			// Автоматическое скрытие
			setTimeout(() => {
				if (document.body.contains(notification)) {
					notification.style.transform = 'translateX(400px)';
					setTimeout(() => {
						if (document.body.contains(notification)) {
							document.body.removeChild(notification);
						}
					}, 300);
				}
			}, duration);
		},

		switchModal: () => {
			const modal = document.getElementById('hh-api-modal');
			if (modal) {
				STATE.modalVisible = !STATE.modalVisible;
				modal.style.display = STATE.modalVisible ? 'block' : 'none';
				if (STATE.modalVisible) {
					UI.updateModal();
				}
			}
		},

		openModal: () => {
			STATE.modalVisible = true;
			const modal = document.getElementById('hh-api-modal');
			if (modal) {
				modal.style.display = 'block';
				UI.updateModal();
			}
		},

		toggleUI: () => {
			const uiContainer = document.getElementById('hh-api-ui-container');
			if (uiContainer) {
				STATE.uiCollapsed = !STATE.uiCollapsed;
				uiContainer.style.display = STATE.uiCollapsed ? 'none' : 'flex';
			}
		},

		toggleUIVisibility: () => {
			const uiContainer = document.getElementById('hh-api-ui-container');
			if (uiContainer) {
				STATE.uiCollapsed = !STATE.uiCollapsed;
				uiContainer.style.display = STATE.uiCollapsed ? 'none' : 'flex';
			}
		},

		toggleFloatingUI: () => {
			const uiContainer = document.getElementById('hh-api-ui-container');
			const floatingBtn = document.getElementById('hh-floating-button');
			const modal = document.getElementById('hh-api-modal');
			const settingsPanel = document.getElementById('hh-settings-panel');

			if (uiContainer && floatingBtn) {
				STATE.uiCollapsed = !STATE.uiCollapsed;
				uiContainer.style.display = STATE.uiCollapsed ? 'none' : 'flex';

				// При скрытии интерфейса закрываем все окна
				if (STATE.uiCollapsed) {
					// Закрываем модальное окно статистики
					if (modal) {
						STATE.modalVisible = false;
						modal.style.display = 'none';
					}

					// Закрываем панель настроек
					if (settingsPanel) {
						STATE.settingsVisible = false;
						settingsPanel.style.display = 'none';
					}
				}

				// Обновляем текст плавающей кнопки
				UIBuilder.updateFloatingButtonText();
			}
		},

		createSettingsPanel: () => {
			let panel = document.getElementById('hh-settings-panel');
			if (panel) {
				panel.style.display = STATE.settingsVisible ? 'block' : 'none';
				return panel;
			}

			panel = document.createElement('div');
			panel.id = 'hh-settings-panel';
			panel.style.cssText = `
				position: fixed;
				top: 50%;
				left: 50%;
				transform: translate(-50%, -50%);
				width: 600px;
				max-width: 90vw;
				max-height: 80vh;
				overflow-x: hidden;
				overflow-y: auto;
				box-sizing: border-box;
				background: white;
				border-radius: 20px;
				box-shadow: 0 25px 80px rgba(0, 0, 0, 0.2);
				z-index: 10005;
				font-family: system-ui, -apple-system, sans-serif;
				display: ${STATE.settingsVisible ? 'block' : 'none'};
			`;

			panel.innerHTML = `
				<div style="padding: 32px; position: relative; overflow-x: hidden; box-sizing: border-box; max-width: 100%;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px;">
						<h2 style="margin: 0; font-size: 24px; font-weight: 700; color: #1e293b;">⚙️ Настройки</h2>
					</div>
					<button id="settings-close" style="position: absolute; top: 20px; right: 20px; background: rgba(255, 255, 255, 0.95); border: 1px solid #e5e7eb; font-size: 28px; cursor: pointer; color: #64748b; padding: 8px; border-radius: 8px; z-index: 10006; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);">×</button>

					<div style="display: grid; gap: 24px; min-width: 0; max-width: 100%;">
						<!-- Основные настройки -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Основные настройки</h3>
							<div style="display: grid; gap: 12px;">
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-notifications" ${
										STATE.settings.showNotifications ? 'checked' : ''
									}>
									<span>Показывать уведомления</span>
								</label>
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-sound" ${STATE.settings.soundEnabled ? 'checked' : ''}>
									<span>Звуковые уведомления</span>
								</label>
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-autosave" ${STATE.settings.autoSaveConfig ? 'checked' : ''}>
									<span>Автосохранение настроек</span>
								</label>
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-smart-delay" ${STATE.settings.smartDelay ? 'checked' : ''}>
									<span>Умная задержка (адаптивная)</span>
								</label>
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-hide-ui" ${STATE.settings.hideUIOnLoad ? 'checked' : ''}>
									<span>Скрывать интерфейс при загрузке</span>
								</label>
							</div>
						</div>

						<!-- Сохранённые поиски -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Сохранённые поиски</h3>
							<div id="hh-settings-searches" style="display: grid; gap: 8px; margin-bottom: 12px; min-width: 0; max-width: 100%; overflow: hidden;"></div>
							<p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">Управляйте поисками в панели справа или удаляйте их здесь.</p>
						</div>

						<!-- Хеш резюме -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Хеш резюме</h3>
							<input type="text" id="setting-resume-hash" value="${
								CONFIG.RESUME_HASH
							}" style="width: 100%; max-width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="Введите хеш вашего резюме">
						</div>

						<!-- Сопроводительное письмо -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Сопроводительное письмо</h3>
							<textarea id="setting-cover-letter" style="width: 100%; max-width: 100%; box-sizing: border-box; height: 120px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; resize: vertical;" placeholder="Используйте {#vacancyName} для подстановки названия вакансии">${
								CONFIG.COVER_LETTER_TEMPLATE
							}</textarea>
						</div>

						<!-- Фильтры -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Фильтры</h3>
							<div style="display: grid; gap: 12px;">
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-filters" ${STATE.settings.enableFilters ? 'checked' : ''}>
									<span>Включить фильтрацию</span>
								</label>
								<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
									<div>
										<label style="display: block; margin-bottom: 4px; font-weight: 500;">Мин. зарплата:</label>
										<input type="number" id="setting-min-salary" value="${
											CONFIG.MIN_SALARY
										}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;">
									</div>
									<div>
										<label style="display: block; margin-bottom: 4px; font-weight: 500;">Макс. зарплата:</label>
										<input type="number" id="setting-max-salary" value="${
											CONFIG.MAX_SALARY
										}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;">
									</div>
								</div>
								<label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
									<input type="checkbox" id="setting-skip-no-salary" ${CONFIG.SKIP_WITHOUT_SALARY ? 'checked' : ''}>
									<span>Пропускать без зарплаты</span>
								</label>
							</div>
						</div>

						<!-- Ключевые слова -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Ключевые слова</h3>
							<div style="display: grid; gap: 12px;">
								<div>
									<label style="display: block; margin-bottom: 4px; font-weight: 500;">Обязательные слова (через запятую):</label>
									<input type="text" id="setting-required-keywords" value="${CONFIG.REQUIRED_KEYWORDS.join(
										', ',
									)}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="React, JavaScript, Frontend">
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; font-weight: 500;">Исключающие слова (через запятую):</label>
									<input type="text" id="setting-excluded-keywords" value="${CONFIG.EXCLUDED_KEYWORDS.join(
										', ',
									)}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="PHP, Java, Backend">
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; font-weight: 500;">Черный список компаний (через запятую):</label>
									<input type="text" id="setting-blacklist" value="${CONFIG.BLACKLIST_COMPANIES.join(
										', ',
									)}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="Компания1, Компания2">
								</div>
							</div>
						</div>

						<!-- Кнопки -->
						<div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px;">
							<button id="settings-reset" style="padding: 12px 24px; background: #6b7280; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">Сбросить</button>
							<button id="settings-save" style="padding: 12px 24px; background: #3b82f6; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">Сохранить</button>
						</div>
					</div>
				</div>
			`;

			// Обработчики событий
			const settingsCloseBtn = panel.querySelector('#settings-close');
			settingsCloseBtn.onclick = () => {
				STATE.settingsVisible = false;
				panel.style.display = 'none';
			};

			panel.querySelector('#setting-notifications').onchange = () => {
				STATE.settings.showNotifications = panel.querySelector('#setting-notifications').checked;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-sound').onchange = () => {
				STATE.settings.soundEnabled = panel.querySelector('#setting-sound').checked;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-autosave').onchange = () => {
				STATE.settings.autoSaveConfig = panel.querySelector('#setting-autosave').checked;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-smart-delay').onchange = () => {
				STATE.settings.smartDelay = panel.querySelector('#setting-smart-delay').checked;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-hide-ui').onchange = () => {
				STATE.settings.hideUIOnLoad = panel.querySelector('#setting-hide-ui').checked;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-filters').onchange = () => {
				STATE.settings.enableFilters = panel.querySelector('#setting-filters').checked;
				Utils.saveConfig();
			};

			panel.querySelector('#setting-min-salary').onchange = () => {
				CONFIG.MIN_SALARY = parseInt(panel.querySelector('#setting-min-salary').value) || 0;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-max-salary').onchange = () => {
				CONFIG.MAX_SALARY = parseInt(panel.querySelector('#setting-max-salary').value) || 0;
				Utils.saveConfig();
			};
			panel.querySelector('#setting-skip-no-salary').onchange = () => {
				CONFIG.SKIP_WITHOUT_SALARY = panel.querySelector('#setting-skip-no-salary').checked;
				Utils.saveConfig();
			};

			panel.querySelector('#setting-required-keywords').onchange = () => {
				const keywords = panel.querySelector('#setting-required-keywords').value;
				CONFIG.REQUIRED_KEYWORDS = keywords
					? keywords
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s)
					: [];
				Utils.saveConfig();
			};
			panel.querySelector('#setting-excluded-keywords').onchange = () => {
				const keywords = panel.querySelector('#setting-excluded-keywords').value;
				CONFIG.EXCLUDED_KEYWORDS = keywords
					? keywords
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s)
					: [];
				Utils.saveConfig();
			};
			panel.querySelector('#setting-blacklist').onchange = () => {
				const blacklist = panel.querySelector('#setting-blacklist').value;
				CONFIG.BLACKLIST_COMPANIES = blacklist
					? blacklist
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s)
					: [];
				Utils.saveConfig();
			};

			panel.querySelector('#setting-cover-letter').onchange = () => {
				CONFIG.COVER_LETTER_TEMPLATE = panel.querySelector('#setting-cover-letter').value;
				Utils.saveConfig();
			};

			panel.querySelector('#setting-resume-hash').onchange = () => {
				CONFIG.RESUME_HASH = panel.querySelector('#setting-resume-hash').value;
				Utils.saveConfig();
			};

			panel.querySelector('#settings-save').onclick = () => {
				UI.saveSettings();
				UI.showNotification('Сохранено', 'Настройки успешно сохранены', 'success');
			};

			panel.querySelector('#settings-reset').onclick = () => {
				if (confirm('Сбросить все настройки к значениям по умолчанию?')) {
					UI.resetSettings();
					UI.showNotification('Сброшено', 'Настройки сброшены к значениям по умолчанию', 'info');
				}
			};

			document.body.appendChild(panel);
			UI.renderSavedSearchesSettings(panel.querySelector('#hh-settings-searches'));
			return panel;
		},

		renderSavedSearchesSettings: (container) => {
			if (!container) return;
			const items = SavedSearches.getCustom();

			if (items.length === 0) {
				container.innerHTML =
					'<div style="padding:12px;border:1px dashed #dbe3ee;border-radius:12px;color:#64748b;font-size:13px;word-break:break-word;">Пока нет сохранённых поисков. Используйте «+ Сохранить» в панели справа.</div>';
				return;
			}

			container.innerHTML = '';
			items.forEach((item) => {
				const row = document.createElement('div');
				row.style.cssText =
					'display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#f8fafc;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box;';

				const info = document.createElement('div');
				info.style.cssText = 'flex:1;min-width:0;overflow:hidden;';

				const title = document.createElement('div');
				title.style.cssText =
					'font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
				title.textContent = item.name;

				const url = document.createElement('div');
				url.style.cssText =
					'font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
				url.textContent = item.url;
				url.title = item.url;

				info.appendChild(title);
				info.appendChild(url);

				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.textContent = 'Удалить';
				removeBtn.style.cssText =
					'flex-shrink:0;border:none;background:#fee2e2;color:#b91c1c;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;white-space:nowrap;';
				removeBtn.onclick = () => {
					SavedSearches.remove(item.id);
					UI.renderSavedSearchesSettings(container);
					const select = document.getElementById('hh-search-select');
					if (select) UIBuilder.refreshSearchSelect(select);
					UI.showNotification('Удалено', `Поиск «${item.name}» удалён`, 'info');
				};

				row.appendChild(info);
				row.appendChild(removeBtn);
				container.appendChild(row);
			});
		},

		saveSettings: () => {
			const panel = document.getElementById('hh-settings-panel');
			if (!panel) return;

			// Сохраняем настройки
			STATE.settings.showNotifications = panel.querySelector('#setting-notifications').checked;
			STATE.settings.soundEnabled = panel.querySelector('#setting-sound').checked;
			STATE.settings.autoSaveConfig = panel.querySelector('#setting-autosave').checked;
			STATE.settings.smartDelay = panel.querySelector('#setting-smart-delay').checked;
			STATE.settings.enableFilters = panel.querySelector('#setting-filters').checked;
			STATE.settings.hideUIOnLoad = panel.querySelector('#setting-hide-ui').checked;

			CONFIG.MIN_SALARY = parseInt(panel.querySelector('#setting-min-salary').value) || 0;
			CONFIG.MAX_SALARY = parseInt(panel.querySelector('#setting-max-salary').value) || 0;
			CONFIG.SKIP_WITHOUT_SALARY = panel.querySelector('#setting-skip-no-salary').checked;

			const requiredKeywords = panel.querySelector('#setting-required-keywords').value;
			CONFIG.REQUIRED_KEYWORDS = requiredKeywords
				? requiredKeywords
						.split(',')
						.map((s) => s.trim())
						.filter((s) => s)
				: [];

			const excludedKeywords = panel.querySelector('#setting-excluded-keywords').value;
			CONFIG.EXCLUDED_KEYWORDS = excludedKeywords
				? excludedKeywords
						.split(',')
						.map((s) => s.trim())
						.filter((s) => s)
				: [];

			const blacklist = panel.querySelector('#setting-blacklist').value;
			CONFIG.BLACKLIST_COMPANIES = blacklist
				? blacklist
						.split(',')
						.map((s) => s.trim())
						.filter((s) => s)
				: [];

			CONFIG.COVER_LETTER_TEMPLATE = panel.querySelector('#setting-cover-letter').value;
			CONFIG.RESUME_HASH = panel.querySelector('#setting-resume-hash').value;

			Utils.saveConfig();

			STATE.settingsVisible = false;
			panel.style.display = 'none';
		},

		resetSettings: () => {
			// Сброс к значениям по умолчанию
			Object.assign(STATE.settings, {
				autoFindResume: true,
				showNotifications: true,
				soundEnabled: true,
				darkMode: false,
				enableFilters: true,
				pauseOnError: false,
				autoSaveConfig: true,
				smartDelay: true,
				skipDuplicates: true,
				detailedLogging: true,
				hideUIOnLoad: true,
			});

			Object.assign(CONFIG, {
				RESUME_HASH: '',
				MAX_RESPONSES_PER_SESSION: 50,
				MIN_SALARY: 0,
				MAX_SALARY: 0,
				SKIP_WITHOUT_SALARY: false,
				BLACKLIST_COMPANIES: [],
				REQUIRED_KEYWORDS: [],
				EXCLUDED_KEYWORDS: [],
				COVER_LETTER_TEMPLATE: `Здравствуйте! Меня заинтересовала ваша вакансия "{#vacancyName}". У меня есть необходимый опыт и навыки для этой позиции. Буду рад обсудить детали сотрудничества.`,
			});

			Utils.saveConfig();

			// Обновляем панель настроек
			const panel = document.getElementById('hh-settings-panel');
			if (panel) {
				panel.remove();
				UI.createSettingsPanel();
			}
		},

		openSettings: () => {
			STATE.settingsVisible = true;
			UI.createSettingsPanel();
			const panel = document.getElementById('hh-settings-panel');
			UI.renderSavedSearchesSettings(panel?.querySelector('#hh-settings-searches'));
		},

		switchSettings: () => {
			const panel = document.getElementById('hh-settings-panel');
			if (panel) {
				STATE.settingsVisible = !STATE.settingsVisible;
				panel.style.display = STATE.settingsVisible ? 'block' : 'none';
			} else {
				STATE.settingsVisible = true;
				UI.createSettingsPanel();
			}
		},
	};

	// ===== ПРОВЕРКА ВАКАНСИИ =====
	async function checkVacancyStatus(vacancyId) {
		const xsrf = Utils.getXsrfToken();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

		try {
			const res = await fetch(`${CONFIG.VACANCY_POPUP_API}?vacancyId=${vacancyId}`, {
				credentials: 'include',
				headers: Utils.getHhApiHeaders(xsrf),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				let errorMsg = `HTTP ${res.status} ${res.statusText}`;

				if (res.status === 403) {
					try {
						const body = await res.text();
						if (body.includes('hhcaptcha') || body.includes('isBot')) {
							errorMsg = 'Капча / защита от ботов';
						}
					} catch {
						// оставляем исходное сообщение
					}
				}

				console.error(`❌ Ошибка проверки вакансии ${vacancyId}: ${errorMsg}`);
				return { error: true, message: errorMsg };
			}

			const data = await res.json();

			if (data.archived) {
				return { error: true, message: 'Архивирована' };
			}

			if (data.test?.hasTests || data.test?.required || data.test?.required === true) {
				return { error: true, message: 'Требуется тест', manual: true, reason: 'Требуется тест' };
			}

			if (data.letterRequired || data.letter_required) {
				if (!CONFIG.COVER_LETTER_TEMPLATE?.trim()) {
					return {
						error: true,
						message: 'Обязательное письмо',
						manual: true,
						reason: 'Обязательное сопроводительное',
					};
				}
			}

			return { error: false, data };
		} catch (err) {
			clearTimeout(timeoutId);

			// Обработка сетевых ошибок с таймаутами: детальная классификация ошибок
			// Разные типы ошибок требуют разных подходов к повторным попыткам
			let errorMsg = 'Неизвестная сетевая ошибка';
			if (err.name === 'AbortError') {
				errorMsg = 'Таймаут запроса (10 сек)';
			} else if (err.message) {
				errorMsg = err.message;
			}

			console.error(`❌ Ошибка проверки вакансии ${vacancyId}: ${errorMsg}`, err);
			return { error: true, message: errorMsg };
		}
	}

	// ===== ОТПРАВКА ОТКЛИКА =====
	async function respondToVacancy(vacancyId, title, retryCount = 0) {
		STATE.currentVacancy = title;
		UI.updateRunProgress();

		try {
			// Проверяем, не отправляли ли уже отклик
			if (STATE.settings.skipDuplicates && Responses.isAlreadyResponded(vacancyId)) {
				STATE.consecutiveDuplicates++;
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: false,
					message: 'Дубликат',
				});
				STATE.totalSkipped++;
				STATE.currentVacancy = null; // Сбрасываем текущую вакансию при пропуске дубликата

				// Останавливаем при 3 подряд дубликатах
				if (STATE.consecutiveDuplicates >= 3) {
					console.log('🛑 Достигнуто 3 подряд дубликата. Останавливаю процесс.');
					UI.showNotification(
						'Остановка',
						'Обнаружено 3 подряд дубликата. Процесс остановлен.',
						'warning',
						6000,
					);
					stopProcess();
				}
				return;
			} else {
				// Сбрасываем счетчик дубликатов при успешной проверке
				STATE.consecutiveDuplicates = 0;
			}

			// Проверяем статус вакансии
			const statusCheck = await checkVacancyStatus(vacancyId);
			if (statusCheck.error) {
				// Сбрасываем счетчик дубликатов при пропуске по другим причинам
				STATE.consecutiveDuplicates = 0;
				if (statusCheck.manual) {
					ManualQueue.add({
						id: vacancyId,
						title,
						reason: statusCheck.reason || statusCheck.message,
					});
				}
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: false,
					message: statusCheck.message,
				});
				STATE.totalSkipped++;
				STATE.currentVacancy = null; // Сбрасываем текущую вакансию при ошибке
				return;
			}

			const xsrf = Utils.getXsrfToken();
			if (!xsrf) {
				// Сбрасываем счетчик дубликатов при ошибке токена
				STATE.consecutiveDuplicates = 0;
				console.error('❌ _xsrf-токен не найден');
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: false,
					message: 'Нет токена',
				});
				STATE.totalErrors++;
				STATE.currentVacancy = null; // Сбрасываем текущую вакансию при ошибке
				return;
			}

			const form = new FormData();
			form.append('_xsrf', xsrf);
			form.append('vacancy_id', vacancyId);
			form.append('resume_hash', CONFIG.RESUME_HASH);
			form.append('ignore_postponed', 'true');

			const coverLetter = CONFIG.COVER_LETTER_TEMPLATE.replace('{#vacancyName}', title);
			if (coverLetter.trim()) {
				form.append('letter', coverLetter);
			}

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

			const res = await fetch(CONFIG.VACANCY_API_URL, {
				method: 'POST',
				credentials: 'include',
				headers: Utils.getHhApiHeaders(xsrf),
				body: form,
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				let errorData;
				try {
					errorData = await res.json();
				} catch {
					errorData = { error: `HTTP ${res.status}` };
				}

				const errorCode = errorData.error;
				console.error('Ошибка отправки:', errorData);

				if (errorCode === 'negotiations-limit-exceeded') {
					Logger.saveLog({
						id: vacancyId,
						title,
						time: new Date().toISOString(),
						success: false,
						message: 'Лимит превышен',
					});
					stopProcess();
					UI.showNotification('Лимит превышен', 'Достигнут дневной лимит откликов', 'error');
					return;
				} else if (errorCode === 'test-required') {
					ManualQueue.add({
						id: vacancyId,
						title,
						reason: 'Требуется тест',
					});
					Logger.saveLog({
						id: vacancyId,
						title,
						time: new Date().toISOString(),
						success: false,
						message: 'Требуется тест',
					});
					STATE.totalSkipped++;
					STATE.currentVacancy = null; // Сбрасываем текущую вакансию при ошибке
					return;
				} else if (errorCode === 'already_responded') {
					STATE.consecutiveAlreadyApplied++;
					Logger.saveLog({
						id: vacancyId,
						title,
						time: new Date().toISOString(),
						success: false,
						message: 'Уже отправлен',
					});
					Responses.markAsResponded(vacancyId);
					STATE.totalSkipped++;

					// Останавливаем при 3 подряд Already applied
					if (STATE.consecutiveAlreadyApplied >= 3) {
						console.log('🛑 Достигнуто 3 подряд Already applied. Останавливаю процесс.');
						UI.showNotification(
							'Остановка',
							'Обнаружено 3 подряд уже отправленных отклика. Процесс остановлен.',
							'warning',
							6000,
						);
						STATE.currentVacancy = null; // Сбрасываем текущую вакансию при остановке
						stopProcess();
					} else {
						STATE.currentVacancy = null; // Сбрасываем текущую вакансию после обработки Already applied
					}
					return;
				} else if (res.status === 403 || res.status === 429 || errorCode === 'forbidden') {
					Logger.saveLog({
						id: vacancyId,
						title,
						time: new Date().toISOString(),
						success: false,
						message: res.status === 403 ? 'Доступ запрещён (403)' : `HTTP ${res.status}`,
					});
					STATE.totalSkipped++;
					STATE.currentVacancy = null;
					return;
				} else if (retryCount < CONFIG.MAX_RETRIES) {
					// Логика повторных попыток: при сетевых ошибках делаем повторные попытки с фиксированной задержкой
					// Это fallback-механизм для временных проблем с сетью или сервером
					console.log(
						`Повторная попытка ${retryCount + 1}/${CONFIG.MAX_RETRIES} для вакансии ${vacancyId}`,
					);
					await Utils.delay(CONFIG.RETRY_DELAY);
					return respondToVacancy(vacancyId, title, retryCount + 1);
				} else {
					Logger.saveLog({
						id: vacancyId,
						title,
						time: new Date().toISOString(),
						success: false,
						message: errorData.error || 'Неизвестная ошибка',
					});
					STATE.totalErrors++;
					STATE.consecutiveFailures++;

					// Не паузим процесс, продолжаем с экспоненциальной задержкой
					return;
				}
			} else {
				STATE.responsesCount++;
				STATE.consecutiveFailures = 0; // Сбрасываем счетчик при успехе
				STATE.consecutiveAlreadyApplied = 0; // Сбрасываем счетчик Already applied при успехе
				STATE.consecutiveDuplicates = 0; // Сбрасываем счетчик дубликатов при успехе
				STATE.currentVacancy = null; // Сбрасываем текущую вакансию после успешного отклика
				Responses.markAsResponded(vacancyId);
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: true,
				});
			}
		} catch (err) {
			let errorMsg = 'Неизвестная сетевая ошибка';
			if (err.name === 'AbortError') {
				errorMsg = 'Таймаут запроса (10 сек)';
			} else if (err.message) {
				errorMsg = err.message;
			}

			console.error(`❌ Ошибка отправки отклика на вакансию ${vacancyId}: ${errorMsg}`, err);

			if (retryCount < CONFIG.MAX_RETRIES) {
				console.log(
					`Повторная попытка ${retryCount + 1}/${CONFIG.MAX_RETRIES} для вакансии ${vacancyId}`,
				);
				await Utils.delay(CONFIG.RETRY_DELAY);
				return respondToVacancy(vacancyId, title, retryCount + 1);
			} else {
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: false,
					message: errorMsg,
				});
				STATE.totalErrors++;
				STATE.consecutiveFailures++;
				STATE.currentVacancy = null; // Сбрасываем текущую вакансию при ошибке

				// Не паузим процесс, продолжаем с экспоненциальной задержкой
			}
		}
	}

	// ===== ОБРАБОТКА СТРАНИЦ =====
	async function processPage(url, pageNum) {
		const prepared = Utils.prepareProcessUrl(url);
		if (!prepared.url) {
			console.error(`❌ Некорректный URL для обработки: ${prepared.error}`);
			return false;
		}

		let pageUrl = prepared.url;

		// Правильно добавляем параметр page, не ломая существующие параметры
		try {
			const urlObj = new URL(pageUrl);
			urlObj.searchParams.set('page', pageNum);
			pageUrl = urlObj.toString();
		} catch {
			// Fallback на старую логику, если URL некорректен
			pageUrl = pageUrl.includes('?') ? `${pageUrl}&page=${pageNum}` : `${pageUrl}?page=${pageNum}`;
		}

		console.log(`📄 Обрабатываю страницу ${pageNum + 1}: ${pageUrl}`);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

		try {
			const res = await fetch(pageUrl, {
				credentials: 'include',
				headers: Utils.getHhApiHeaders(Utils.getXsrfToken(), {
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const errorMsg = `HTTP ${res.status} ${res.statusText}`;
				console.error(`❌ Ошибка загрузки страницы ${pageNum + 1}: ${errorMsg}`);
				return false;
			}

			const text = await res.text();
			let vacancies = Utils.parseVacanciesFromSearchPage(text);

			if (!vacancies || vacancies.length === 0) {
				const parser = new DOMParser();
				const doc = parser.parseFromString(text, 'text/html');

				// Fallback-механизмы поиска вакансий: множественные стратегии поиска элементов
				// HH.ru часто меняет CSS-классы, поэтому используем каскадный поиск с запасными вариантами
				let cards = doc.querySelectorAll('[data-qa="vacancy-serp__vacancy"]');
				if (cards.length === 0) {
					cards = doc.querySelectorAll('.vacancy-serp-item');
				}
				if (cards.length === 0) {
					cards = Array.from(doc.querySelectorAll('[data-qa="serp-item__title"]'))
						.map(
							(link) => link.closest('[data-qa*="vacancy"]') || link.closest('.vacancy-serp-item'),
						)
						.filter(Boolean);
				}

				if (cards.length === 0) {
					console.log('🔚 Вакансии на странице не найдены. Завершаю обработку.');
					return false;
				}

				vacancies = Array.from(cards)
					.map((card) => extractVacancyData(card))
					.filter(Boolean);
			}

			if (!vacancies || vacancies.length === 0) {
				console.log('🔚 Вакансии на странице не найдены. Завершаю обработку.');
				return false;
			}

			console.log(`📋 Найдено ${vacancies.length} вакансий на странице ${pageNum + 1}`);

			let processedOnPage = 0;
			let successfulOnPage = 0;

			for (let i = 0; i < vacancies.length; i++) {
				const vacancyData = vacancies[i];
				// Проверяем условия остановки
				if (!STATE.isRunning || Utils.shouldStopSession()) {
					console.log(
						`🛑 Остановка: isRunning=${STATE.isRunning}, responses=${STATE.responsesCount}/${Utils.getSessionLimit()}`,
					);
					break;
				}

				// Проверяем паузу
				while (STATE.isPaused && STATE.isRunning) {
					await Utils.delay(1000);
				}

				if (!STATE.isRunning) break;

				if (vacancyData.alreadyApplied) {
					console.log(`⏭️ Пропускаю вакансию ${vacancyData.id}: уже откликались`);
					STATE.totalSkipped++;
					continue;
				}

				if (vacancyData.hasTest) {
					console.log(`⏭️ Пропускаю вакансию ${vacancyData.id}: требуется тест`);
					ManualQueue.add({
						id: vacancyData.id,
						title: vacancyData.title,
						reason: 'Требуется тест',
						href: vacancyData.href,
					});
					Logger.saveLog({
						id: vacancyData.id,
						title: vacancyData.title,
						time: new Date().toISOString(),
						success: false,
						message: 'Требуется тест',
					});
					STATE.totalSkipped++;
					continue;
				}

				console.log(
					`🔍 Обрабатываю вакансию ${i + 1}/${vacancies.length}: ${vacancyData.title} (ID: ${
						vacancyData.id
					})`,
				);
				STATE.totalProcessed++;
				processedOnPage++;

				// Применяем фильтры
				const filterResult = Filters.shouldSkipVacancy(vacancyData);
				if (filterResult.skip) {
					// Сбрасываем счетчик дубликатов при пропуске по фильтрам
					STATE.consecutiveDuplicates = 0;
					console.log(
						`⏭️ Пропускаю вакансию ${vacancyData.id}: ${filterResult.reasons.join(', ')}`,
					);
					Logger.saveLog({
						id: vacancyData.id,
						title: vacancyData.title,
						time: new Date().toISOString(),
						success: false,
						message: filterResult.reasons.join(', '),
					});
					STATE.totalSkipped++;
					continue;
				}

				// Отправляем отклик
				const beforeCount = STATE.responsesCount;
				await respondToVacancy(vacancyData.id, vacancyData.title);

				// Проверяем, был ли отправлен отклик
				if (STATE.responsesCount > beforeCount) {
					successfulOnPage++;
					console.log(`✅ Отклик отправлен на вакансию ${vacancyData.id}`);
				} else {
					console.log(`❌ Отклик не отправлен на вакансию ${vacancyData.id}`);
				}

				// Умная задержка между вакансиями с учетом consecutiveFailures
				if (i < vacancies.length - 1) {
					// Не делаем задержку после последней вакансии
					let delay = Utils.getSmartDelay();
					const smartDelay = delay;

					// Логика экспоненциальной задержки: при последовательных неудачах увеличиваем задержку
					// Это предотвращает перегрузку сервера и дает время на восстановление
					// Формула: 2^(failures-1) * 1000мс = 1с, 2с, 4с, 8с, 16с... при 1,2,3,4... неудачах
					if (STATE.consecutiveFailures > 0) {
						const exponentialDelay = Math.pow(2, STATE.consecutiveFailures - 1) * 1000; // 1с, 2с, 4с, 8с...
						delay = Math.max(delay, exponentialDelay);
						console.log(
							`⚠️ Задержка ${delay}мс (умная: ${smartDelay}мс, экспоненциальная: ${exponentialDelay}мс) из-за ${STATE.consecutiveFailures} подряд неудач`,
						);
					} else {
						console.log(`⏰ Умная задержка ${delay}мс`);
					}

					console.log(`⏳ Задержка ${delay}мс перед следующей вакансией...`);
					await Utils.randomDelay(delay * 0.8, delay * 1.2);
				}
			}

			console.log(
				`📊 Страница ${
					pageNum + 1
				} завершена: обработано ${processedOnPage}, отправлено ${successfulOnPage}`,
			);

			// Возвращаем true если на странице были вакансии (даже если все пропущены)
			return vacancies.length > 0;
		} catch (err) {
			clearTimeout(timeoutId);

			// Обработка сетевых ошибок с таймаутами: детальная классификация ошибок
			// Разные типы ошибок требуют разных подходов к повторным попыткам
			let errorMsg = 'Неизвестная сетевая ошибка';
			if (err.name === 'AbortError') {
				errorMsg = 'Таймаут запроса (10 сек)';
			} else if (err.message) {
				errorMsg = err.message;
			}

			console.error(`❌ Ошибка обработки страницы ${pageNum + 1}: ${errorMsg}`, err);
			STATE.totalErrors++;
			return false;
		}
	}

	function extractVacancyData(card) {
		// Поиск ссылки на вакансию
		let link = card.querySelector("a[data-qa='serp-item__title']");
		if (!link) {
			link = card.querySelector("a[href*='/vacancy/']");
		}
		if (!link) {
			link = card.querySelector('h3 a, .vacancy-serp-item__row_header a');
		}

		const titleElement =
			card.querySelector('[data-qa="serp-item__title-text"]') ||
			card.querySelector('[data-qa="serp-item__title"]') ||
			link;

		const title = titleElement?.textContent?.trim() || link?.innerText?.trim();
		const href = link?.href;

		if (!title || !href) {
			console.log('⚠️ Не найдена ссылка или заголовок вакансии');
			return null;
		}

		const vacancyId = href.match(/vacancy\/(\d+)/)?.[1];
		if (!vacancyId) {
			console.log('⚠️ Не удалось извлечь ID вакансии из URL:', href);
			return null;
		}

		// Извлекаем дополнительную информацию
		const salaryElement =
			card.querySelector('[data-qa="vacancy-serp__vacancy-compensation"]') ||
			card.querySelector('[data-qa="compensation"]');
		const salary = salaryElement?.textContent?.trim() || '';

		const companyElement =
			card.querySelector('[data-qa="vacancy-serp__vacancy-employer"]') ||
			card.querySelector('[data-qa="vacancy-serp__vacancy-employer-text"]');
		const company = companyElement?.textContent?.trim() || '';

		const descriptionElement =
			card.querySelector('[data-qa="vacancy-serp__vacancy_snippet_requirement"]') ||
			card.querySelector('[data-qa="vacancy-serp__vacancy_snippet_responsibility"]');
		const description = descriptionElement?.textContent?.trim() || '';

		const hasTest = Boolean(card.querySelector('[data-qa="vacancy-serp__vacancy_test"]'));
		const alreadyApplied = Boolean(
			card.querySelector(
				'[data-qa="vacancy-serp__vacancy_response"] [data-qa="vacancy-serp__vacancy-response-sent"]',
			) || card.querySelector('[data-qa="vacancy-serp__vacancy-response-sent"]'),
		);

		return {
			id: vacancyId,
			title,
			salary,
			company,
			description,
			href,
			hasTest,
			alreadyApplied,
		};
	}

	async function processAllPages(baseUrl) {
		let pageNum = 0;
		let hasMorePages = true;
		let consecutiveErrors = 0;
		let consecutiveEmptyPages = 0;
		const maxConsecutiveErrors = 3;
		const maxConsecutiveEmptyPages = 2;
		const maxPages = 100; // Ограничение на максимальное количество страниц

		console.log(`🚀 Начинаю обработку страниц с URL: ${baseUrl}`);

		while (hasMorePages && STATE.isRunning && !Utils.shouldStopSession() && pageNum < maxPages) {
			// Проверяем паузу
			while (STATE.isPaused && STATE.isRunning) {
				await Utils.delay(1000);
			}

			if (!STATE.isRunning) {
				console.log('🛑 Процесс остановлен пользователем');
				break;
			}

			console.log(`📄 Переход к странице ${pageNum + 1}...`);
			const pageProcessed = await processPage(baseUrl, pageNum);

			if (!pageProcessed) {
				consecutiveErrors++;
				consecutiveEmptyPages++;
				console.log(
					`❌ Страница ${
						pageNum + 1
					} не обработана. Ошибок подряд: ${consecutiveErrors}, пустых страниц: ${consecutiveEmptyPages}`,
				);

				if (consecutiveErrors >= maxConsecutiveErrors) {
					console.log('🔚 Слишком много ошибок подряд. Завершаю обработку.');
					break;
				}

				if (consecutiveEmptyPages >= maxConsecutiveEmptyPages) {
					console.log('🔚 Слишком много пустых страниц подряд. Возможно, достигнут конец списка.');
					break;
				}
			} else {
				consecutiveErrors = 0;
				consecutiveEmptyPages = 0;
				console.log(`✅ Страница ${pageNum + 1} успешно обработана`);
			}

			pageNum++;
			STATE.currentPage = pageNum;

			// Проверяем лимиты
			if (Utils.shouldStopSession()) {
				console.log('🔚 Достигнут лимит откликов за запуск или дневной лимит.');
				break;
			}

			if (pageNum >= maxPages) {
				console.log('🔚 Достигнуто максимальное количество страниц.');
				break;
			}

			// Задержка между страницами (только если есть еще страницы для обработки)
			if (STATE.isRunning && pageProcessed) {
				console.log(`⏳ Задержка ${CONFIG.DELAY_BETWEEN_PAGES}мс перед следующей страницей...`);
				await Utils.delay(CONFIG.DELAY_BETWEEN_PAGES);
			}
		}

		console.log(
			`🏁 Обработка завершена. Всего страниц: ${pageNum}, откликов: ${STATE.responsesCount}`,
		);

		if (
			STATE.responsesCount >= Utils.getSessionLimit() ||
			STATE.responsesCount >= CONFIG.MAX_RESPONSES_PER_DAY
		) {
			console.log('🔚 Достигнут лимит откликов за запуск или дневной лимит.');
		} else {
			console.log('✅ Все доступные страницы обработаны!');
		}

		stopProcess();
	}

	// ===== УПРАВЛЕНИЕ ПРОЦЕССОМ =====
	function stopProcess() {
		// Защита от множественных вызовов
		if (!STATE.isRunning) return;

		STATE.isRunning = false;
		STATE.isPaused = false;
		STATE.currentVacancy = null;

		UI.updateRunProgress();
		// (хотя на самом деле он должен работать постоянно, но на всякий случай)

		const btn = document.getElementById('hh-api-button');
		if (btn) {
			const pageType = Utils.detectPageType();
			if (pageType === 'vacancy') {
				btn.textContent = '📤 Откликнуться';
			} else {
				btn.textContent = '📤 Отправить отклики';
			}
			btn.style.background = 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)';
		}

		const pauseBtn = document.getElementById('hh-pause-button');
		if (pauseBtn) {
			pauseBtn.style.display = 'none';
		}

		Logger.updateStats();

		const stats = Utils.getFormattedStats();
		UI.showNotification(
			'Завершено',
			`Отправлено ${stats.totalSent} из ${stats.totalProcessed} вакансий`,
			'info',
			6000,
		);
	}

	function pauseProcess() {
		if (!STATE.isRunning) return;

		STATE.isPaused = !STATE.isPaused;

		if (STATE.isPaused) {
			STATE.pauseTime = Date.now();
		} else {
			if (STATE.pauseTime) {
				STATE.totalPauseTime += Date.now() - STATE.pauseTime;
				STATE.pauseTime = null;
			}
		}

		const pauseBtn = document.getElementById('hh-pause-button');
		if (pauseBtn) {
			pauseBtn.textContent = STATE.isPaused ? '▶️ Продолжить' : '⏸️ Пауза';
		}

		UI.showNotification(
			STATE.isPaused ? 'Приостановлено' : 'Продолжено',
			STATE.isPaused ? 'Процесс приостановлен' : 'Процесс продолжен',
			'info',
		);
	}

	function startProcess(url) {
		// Защита от множественных запусков
		if (STATE.isRunning) {
			console.warn('⚠️ Процесс уже запущен, игнорирую повторный запуск');
			return;
		}

		// Проверяем RESUME_HASH
		if (!CONFIG.RESUME_HASH) {
			UI.showNotification(
				'Ошибка конфигурации',
				'Не указан RESUME_HASH! Откройте настройки и укажите хеш резюме.',
				'error',
				8000,
			);
			return;
		}

		// Определяем тип страницы
		const pageType = Utils.detectPageType();

		// Для страницы вакансии - одиночный отклик
		if (pageType === 'vacancy') {
			startSingleVacancyProcess();
			return;
		}

		const prepared = Utils.prepareProcessUrl(url);
		if (!prepared.url) {
			UI.showNotification('Ошибка', prepared.error, 'error', 8000);
			return;
		}

		url = prepared.url;

		if (prepared.converted) {
			UI.showNotification(
				'Ссылка преобразована',
				'Подборка /vacancies/... заменена на поиск. Для точных фильтров скопируйте URL из /search/vacancy?...',
				'warning',
				7000,
			);
		}

		// Проверяем дневной лимит
		const sentToday = Responses.getSentToday();
		if (sentToday >= CONFIG.MAX_RESPONSES_PER_DAY) {
			UI.showNotification(
				'Лимит превышен',
				`Сегодня уже отправлено ${sentToday} откликов. Дневной лимит: ${CONFIG.MAX_RESPONSES_PER_DAY}`,
				'warning',
				6000,
			);
			return;
		}

		console.log('✅ Начинаю обработку вакансий...');
		console.log('🔍 URL для обработки:', url);
		console.log(`🎛️ Фильтры скрипта: ${STATE.settings.enableFilters ? 'включены' : 'выключены'}`);

		// Сброс состояния
		STATE.responsesCount = 0;
		STATE.totalProcessed = 0;
		STATE.totalSkipped = 0;
		STATE.totalErrors = 0;
		STATE.currentPage = 0;
		STATE.isRunning = true;
		STATE.isPaused = false;
		STATE.startTime = Date.now();
		STATE.totalPauseTime = 0;
		STATE.currentVacancy = null;
		STATE.consecutiveFailures = 0;
		STATE.consecutiveAlreadyApplied = 0;
		STATE.consecutiveDuplicates = 0;

		// Обновляем UI
		const btn = document.getElementById('hh-api-button');
		if (btn) {
			btn.textContent = '⏹️ Остановить';
			btn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
		}

		const pauseBtn = document.getElementById('hh-pause-button');
		if (pauseBtn) {
			pauseBtn.style.display = 'block';
			pauseBtn.textContent = '⏸️ Пауза';
		}

		// Показываем модальное окно
		UI.openModal();

		UI.showNotification('Запущено', 'Начинаю отправку откликов по текущему поиску', 'success');
		processAllPages(url);
	}

	// Обработка одиночной вакансии
	async function startSingleVacancyProcess() {
		console.log('🔍 Начинаю обработку одиночной вакансии...');

		// Получаем данные вакансии
		const vacancyData = Utils.getCurrentVacancyData();
		if (!vacancyData) {
			UI.showNotification('Ошибка', 'Не удалось определить вакансию на странице', 'error');
			return;
		}

		// Проверяем наличие кнопки отклика
		if (!Utils.hasRespondButton()) {
			UI.showNotification(
				'Внимание',
				'На странице нет кнопки отклика. Возможно, вакансия уже закрыта или отклик уже отправлен.',
				'warning',
			);
			return;
		}

		// Проверяем, закрыта ли вакансия
		if (Utils.isVacancyClosed()) {
			UI.showNotification('Вакансия закрыта', 'Отклики на эту вакансию невозможны', 'warning');
			return;
		}

		console.log(`📋 Обрабатываю вакансию: ${vacancyData.title} (ID: ${vacancyData.id})`);

		// Проверяем дневной лимит
		const sentToday = Responses.getSentToday();
		if (sentToday >= CONFIG.MAX_RESPONSES_PER_DAY) {
			UI.showNotification(
				'Лимит превышен',
				`Сегодня уже отправлено ${sentToday} откликов. Дневной лимит: ${CONFIG.MAX_RESPONSES_PER_DAY}`,
				'warning',
				6000,
			);
			return;
		}

		// Сброс состояния для одиночного отклика
		STATE.responsesCount = 0;
		STATE.totalProcessed = 0;
		STATE.totalSkipped = 0;
		STATE.totalErrors = 0;
		STATE.isRunning = true;
		STATE.isPaused = false;
		STATE.startTime = Date.now();
		STATE.totalPauseTime = 0;
		STATE.currentVacancy = vacancyData.title;
		STATE.consecutiveFailures = 0;
		STATE.consecutiveAlreadyApplied = 0;

		// Обновляем UI
		const btn = document.getElementById('hh-api-button');
		if (btn) {
			btn.textContent = '⏹️ Остановить';
			btn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
		}

		// Показываем модальное окно
		UI.openModal();

		UI.showNotification('Запущено', `Отправляю отклик на: ${vacancyData.title}`, 'success');

		// Обрабатываем вакансию
		STATE.totalProcessed++;

		// Применяем фильтры
		const filterResult = Filters.shouldSkipVacancy(vacancyData);
		if (filterResult.skip) {
			console.log(`⏭️ Пропускаю вакансию: ${filterResult.reasons.join(', ')}`);
			Logger.saveLog({
				id: vacancyData.id,
				title: vacancyData.title,
				time: new Date().toISOString(),
				success: false,
				message: filterResult.reasons.join(', '),
			});
			STATE.totalSkipped++;
			stopProcess();
			return;
		}

		// Отправляем отклик
		await respondToVacancy(vacancyData.id, vacancyData.title);
		stopProcess();
	}

	// ===== СОЗДАНИЕ UI =====
	const UIBuilder = {
		createMainInterface: () => {
			// Удаляем существующий интерфейс
			const existing = document.getElementById('hh-api-ui-container');
			if (existing) existing.remove();

			const container = document.querySelector('.supernova-navi-items') || document.body;

			const uiContainer = document.createElement('div');
			uiContainer.id = 'hh-api-ui-container';
			uiContainer.style.cssText = `
				position: fixed;
				bottom: 100px;
				right: 20px;
				z-index: 9999;
				display: flex;
				flex-direction: column;
				gap: 12px;
				width: 400px;
				font-family: system-ui, -apple-system, sans-serif;
			`;

			// Создаем элементы интерфейса
			const controlPanel = UIBuilder.createControlPanel();
			const mainButton = UIBuilder.createMainButton();
			const pauseButton = UIBuilder.createPauseButton();
			const controlButtons = UIBuilder.createControlButtons();

			uiContainer.appendChild(controlPanel);
			uiContainer.appendChild(mainButton);
			uiContainer.appendChild(pauseButton);
			uiContainer.appendChild(controlButtons);
			container.appendChild(uiContainer);

			// Создаем плавающую кнопку
			UIBuilder.createFloatingButton();

			// Применяем настройку скрытия интерфейса при загрузке
			if (STATE.settings.hideUIOnLoad) {
				uiContainer.style.display = 'none';
				STATE.uiCollapsed = true;
			} else {
				STATE.uiCollapsed = false;
			}

			// Добавляем индикатор типа страницы
			UIBuilder.createPageTypeIndicator(uiContainer);

			// Обновляем текст плавающей кнопки после инициализации
			UIBuilder.updateFloatingButtonText();
		},

		createControlPanel: () => {
			UIBuilder.injectPanelStyles();

			const panel = document.createElement('div');
			panel.className = 'hh-panel';
			panel.innerHTML = `
				<div class="hh-panel-section">
					<div class="hh-panel-label">Поиск вакансий</div>
					<select id="hh-search-select" class="hh-select"></select>
					<div class="hh-panel-row">
						<button type="button" id="hh-use-current-search" class="hh-btn-ghost">↻ Текущая страница</button>
						<button type="button" id="hh-save-search-toggle" class="hh-btn-ghost">+ Сохранить</button>
					</div>
					<div id="hh-save-search-form" class="hh-inline-form" style="display:none;">
						<input id="hh-save-search-name" class="hh-input" type="text" placeholder="Название, например DevOps Москва">
						<button type="button" id="hh-save-search-confirm" class="hh-btn-small">OK</button>
					</div>
					<div id="hh-search-hint" class="hh-hint"></div>
				</div>
				<div class="hh-panel-section">
					<div class="hh-panel-label">Лимит за запуск</div>
					<div id="hh-limit-chips" class="hh-chips"></div>
					<div class="hh-limit-custom">
						<input id="hh-session-limit" class="hh-input hh-input-compact" type="number" min="1" max="200" value="${CONFIG.MAX_RESPONSES_PER_SESSION}">
						<span class="hh-hint-inline">откликов (макс. ${CONFIG.MAX_RESPONSES_PER_DAY}/день)</span>
					</div>
				</div>
			`;

			UIBuilder.refreshSearchSelect(panel.querySelector('#hh-search-select'));
			UIBuilder.renderLimitChips(panel.querySelector('#hh-limit-chips'));

			const pageType = Utils.detectPageType();
			const hint = panel.querySelector('#hh-search-hint');
			if (hint) {
				if (SavedSearches.getCustom().length === 0) {
					hint.textContent =
						'Показаны примеры поисков — сохраните свой или выберите текущую страницу';
				} else if (pageType === 'search') {
					hint.textContent = 'Можно выбрать сохранённый поиск или текущую страницу';
				} else {
					hint.textContent = 'Выберите сохранённый поиск перед запуском';
				}
			}

			if (pageType === 'vacancy') {
				panel.style.opacity = '0.65';
				panel.style.pointerEvents = 'none';
			}

			const select = panel.querySelector('#hh-search-select');
			if (select) {
				select.onchange = () => {
					SavedSearches.setSelectedId(select.value);
				};
			}

			const useCurrentBtn = panel.querySelector('#hh-use-current-search');
			if (useCurrentBtn) {
				useCurrentBtn.onclick = () => {
					if (select) {
						select.value = '__current__';
						SavedSearches.setSelectedId('__current__');
					}
					UI.showNotification('Выбрано', 'Будет использована текущая страница', 'info', 2500);
				};
			}

			const saveToggle = panel.querySelector('#hh-save-search-toggle');
			const saveForm = panel.querySelector('#hh-save-search-form');
			const saveName = panel.querySelector('#hh-save-search-name');
			const saveConfirm = panel.querySelector('#hh-save-search-confirm');

			if (saveToggle && saveForm) {
				saveToggle.onclick = () => {
					const visible = saveForm.style.display !== 'none';
					saveForm.style.display = visible ? 'none' : 'grid';
					if (!visible && saveName) {
						saveName.value = SavedSearches.suggestNameFromUrl(window.location.href);
						saveName.focus();
					}
				};
			}

			if (saveConfirm && saveName && saveForm) {
				saveConfirm.onclick = () => {
					const url =
						select?.value === '__current__' || Utils.detectPageType() === 'search'
							? window.location.href
							: SavedSearches.getUrlById(select?.value || '');
					const entry = SavedSearches.add(saveName.value, url);
					if (!entry) {
						UI.showNotification('Ошибка', 'Укажите название поиска', 'error');
						return;
					}
					saveForm.style.display = 'none';
					UIBuilder.refreshSearchSelect(select, entry.id);
					if (hint) hint.textContent = 'Поиск сохранён — он появится в списке';
					UI.showNotification('Сохранено', `Поиск «${entry.name}» добавлен`, 'success');
				};
			}

			const limitInput = panel.querySelector('#hh-session-limit');
			if (limitInput) {
				limitInput.onchange = () => {
					const value = parseInt(limitInput.value, 10) || CONFIG.MAX_RESPONSES_PER_SESSION;
					CONFIG.MAX_RESPONSES_PER_SESSION = Math.min(
						Math.max(value, 1),
						CONFIG.MAX_RESPONSES_PER_DAY,
					);
					limitInput.value = CONFIG.MAX_RESPONSES_PER_SESSION;
					UIBuilder.renderLimitChips(panel.querySelector('#hh-limit-chips'));
					Utils.saveConfig();
				};
			}

			return panel;
		},

		injectPanelStyles: () => {
			if (document.getElementById('hh-panel-styles')) return;
			const style = document.createElement('style');
			style.id = 'hh-panel-styles';
			style.textContent = `
				.hh-panel {
					display: grid;
					gap: 12px;
					padding: 16px;
					border-radius: 16px;
					background: rgba(255,255,255,0.98);
					border: 1px solid #e5e7eb;
					box-shadow: 0 8px 24px rgba(15,23,42,0.08);
				}
				.hh-panel-section { display: grid; gap: 10px; }
				.hh-panel-label {
					font-size: 12px;
					font-weight: 700;
					letter-spacing: 0.04em;
					text-transform: uppercase;
					color: #64748b;
				}
				.hh-panel-row { display: flex; gap: 8px; }
				.hh-select, .hh-input {
					width: 100%;
					box-sizing: border-box;
					border: 1px solid #dbe3ee;
					border-radius: 12px;
					padding: 12px 14px;
					font: inherit;
					font-size: 14px;
					background: #fff;
					color: #0f172a;
					outline: none;
				}
				.hh-select:focus, .hh-input:focus {
					border-color: #3b82f6;
					box-shadow: 0 0 0 4px rgba(59,130,246,0.12);
				}
				.hh-input-compact { max-width: 88px; padding: 10px 12px; }
				.hh-btn-ghost, .hh-btn-small {
					border: 1px solid #dbe3ee;
					background: #f8fafc;
					color: #334155;
					border-radius: 10px;
					padding: 10px 12px;
					font: inherit;
					font-size: 13px;
					font-weight: 600;
					cursor: pointer;
					transition: all 0.2s ease;
				}
				.hh-btn-ghost { flex: 1; }
				.hh-btn-small { min-width: 52px; }
				.hh-btn-ghost:hover, .hh-btn-small:hover { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }
				.hh-inline-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
				.hh-hint, .hh-hint-inline { font-size: 12px; color: #64748b; line-height: 1.45; }
				.hh-chips { display: flex; flex-wrap: wrap; gap: 8px; }
				.hh-chip {
					border: 1px solid #dbe3ee;
					background: #fff;
					color: #475569;
					border-radius: 999px;
					padding: 8px 12px;
					font-size: 13px;
					font-weight: 600;
					cursor: pointer;
				}
				.hh-chip.active { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
				.hh-limit-custom { display: flex; align-items: center; gap: 10px; }
			`;
			document.head.appendChild(style);
		},

		refreshSearchSelect: (selectEl, forceId) => {
			if (!selectEl) return;
			const options = SavedSearches.getSelectableOptions();
			const pageType = Utils.detectPageType();
			const selectedId =
				forceId ||
				SavedSearches.getSelectedId() ||
				(pageType === 'search' ? '__current__' : options[0]?.id);

			selectEl.innerHTML = '';

			if (pageType !== 'vacancy') {
				const currentOption = document.createElement('option');
				currentOption.value = '__current__';
				currentOption.textContent = '↻ Текущая страница';
				selectEl.appendChild(currentOption);
			}

			options.forEach((item) => {
				const option = document.createElement('option');
				option.value = item.id;
				option.textContent = item.isPreset ? `${item.name} · пример` : item.name;
				selectEl.appendChild(option);
			});

			const hasSelected = Array.from(selectEl.options).some((opt) => opt.value === selectedId);
			selectEl.value = hasSelected ? selectedId : selectEl.options[0]?.value || '';
			SavedSearches.setSelectedId(selectEl.value);
		},

		renderLimitChips: (container) => {
			if (!container) return;
			const presets = [10, 30, 50, 100, 200];
			container.innerHTML = '';

			presets.forEach((value) => {
				const chip = document.createElement('button');
				chip.type = 'button';
				chip.className = `hh-chip${CONFIG.MAX_RESPONSES_PER_SESSION === value ? ' active' : ''}`;
				chip.textContent = String(value);
				chip.onclick = () => {
					CONFIG.MAX_RESPONSES_PER_SESSION = Math.min(value, CONFIG.MAX_RESPONSES_PER_DAY);
					const limitInput = document.getElementById('hh-session-limit');
					if (limitInput) limitInput.value = CONFIG.MAX_RESPONSES_PER_SESSION;
					UIBuilder.renderLimitChips(container);
					Utils.saveConfig();
				};
				container.appendChild(chip);
			});
		},

		createMainButton: () => {
			const pageType = Utils.detectPageType();
			let buttonText = '📤 Отправить отклики';
			let buttonHint = 'Запустите со страницы поиска с нужными фильтрами';

			if (pageType === 'vacancy') {
				const vacancyData = Utils.getCurrentVacancyData();
				if (vacancyData) {
					buttonText = '📤 Откликнуться';
					buttonHint = `Откликнуться на: ${vacancyData.title}`;
				} else {
					buttonText = '📤 Отправить отклики';
					buttonHint = 'Не удалось определить вакансию на странице';
				}
			} else if (pageType === 'search') {
				buttonText = '📤 Отправить отклики';
				buttonHint = 'Обработать вакансии из текущего поиска';
			} else if (pageType === 'employer') {
				buttonText = '📤 Отправить отклики';
				buttonHint = 'Обработать вакансии этого работодателя';
			} else if (pageType === 'collection') {
				buttonText = '📤 Отправить отклики';
				buttonHint = 'Подборка /vacancies/... будет преобразована в поиск';
			} else {
				buttonText = '📤 Отправить отклики';
				buttonHint = 'Вставьте ссылку на поиск вакансий';
			}

			const btn = document.createElement('button');
			btn.id = 'hh-api-button';
			btn.textContent = buttonText;
			btn.title = buttonHint;
			btn.style.cssText = `
				width: 100%;
				padding: 18px;
				background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
				color: #fff;
				border: none;
				border-radius: 12px;
				font-family: inherit;
				font-size: 16px;
				font-weight: 600;
				cursor: pointer;
				transition: all 0.3s ease;
				box-shadow: 0 6px 20px rgba(59, 130, 246, 0.3);
				position: relative;
				overflow: hidden;
			`;

			btn.onmouseover = () => {
				if (!STATE.isRunning) {
					btn.style.transform = 'translateY(-2px)';
					btn.style.boxShadow = '0 8px 25px rgba(59, 130, 246, 0.4)';
				}
			};

			btn.onmouseout = () => {
				btn.style.transform = 'translateY(0)';
				btn.style.boxShadow = '0 6px 20px rgba(59, 130, 246, 0.3)';
			};

			btn.onclick = async () => {
				if (STATE.isRunning) {
					stopProcess();
					return;
				}

				const currentPageType = Utils.detectPageType();

				// Для страницы вакансии не проверяем URL
				if (currentPageType === 'vacancy') {
					startProcess(window.location.href);
					return;
				}

				const rawUrl = SavedSearches.resolveActiveUrl();

				if (!rawUrl) {
					UI.showNotification(
						'Ошибка',
						'Откройте страницу поиска с нужными фильтрами (hh.ru/search/vacancy?...) и запустите оттуда',
						'error',
						8000,
					);
					return;
				}

				if (!Utils.validateUrl(rawUrl)) {
					UI.showNotification('Ошибка', 'Неверный URL! Введите корректную ссылку с HH.ru', 'error');
					return;
				}

				startProcess(rawUrl);
			};

			return btn;
		},

		createPauseButton: () => {
			const btn = document.createElement('button');
			btn.id = 'hh-pause-button';
			btn.textContent = '⏸️ Пауза';
			btn.style.cssText = `
				width: 100%;
				padding: 12px;
				background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
				color: #fff;
				border: none;
				border-radius: 8px;
				font-family: inherit;
				font-size: 14px;
				font-weight: 500;
				cursor: pointer;
				transition: all 0.3s ease;
				display: none;
			`;

			btn.onclick = () => {
				pauseProcess();
			};

			return btn;
		},

		createControlButtons: () => {
			const container = document.createElement('div');
			container.style.cssText = `
				display: grid;
				grid-template-columns: 1fr 1fr 1fr 1fr;
				gap: 8px;
			`;

			// Кнопка настроек
			const settingsBtn = UIBuilder.createControlButton('⚙️', 'Настройки', '#6366f1', () => {
				UI.switchSettings();
			});

			// Кнопка статистики
			const statsBtn = UIBuilder.createControlButton('📊', 'Статистика', '#10b981', () => {
				UI.switchModal();
			});

			// Кнопка экспорта
			const exportBtn = UIBuilder.createControlButton('💾', 'Экспорт', '#6b7280', () => {
				Logger.exportLogs();
				UI.showNotification('Экспорт', 'Данные экспортированы', 'success');
			});

			// Кнопка очистки
			const clearBtn = UIBuilder.createControlButton('🗑️', 'Очистить', '#ef4444', () => {
				Logger.clearLogs();
			});

			container.appendChild(settingsBtn);
			container.appendChild(statsBtn);
			container.appendChild(exportBtn);
			container.appendChild(clearBtn);
			return container;
		},

		createControlButton: (icon, text, color, onClick) => {
			const btn = document.createElement('button');
			btn.innerHTML = `<div style="font-size: 16px; margin-bottom: 2px;">${icon}</div><div style="font-size: 10px;">${text}</div>`;
			btn.style.cssText = `
				padding: 8px 4px;
				background: ${color};
				color: #fff;
				border: none;
				border-radius: 8px;
				font-family: inherit;
				font-weight: 500;
				cursor: pointer;
				transition: all 0.2s ease;
				text-align: center;
				line-height: 1.2;
			`;

			btn.onmouseover = () => {
				btn.style.transform = 'translateY(-1px)';
				btn.style.filter = 'brightness(1.1)';
			};

			btn.onmouseout = () => {
				btn.style.transform = 'translateY(0)';
				btn.style.filter = 'brightness(1)';
			};

			btn.onclick = onClick;
			return btn;
		},

		createPageTypeIndicator: (container) => {
			// Индикаторы типа страницы и RESUME_HASH удалены по требованию
			return null;
		},

		createFloatingButton: () => {
			// Удаляем существующую плавающую кнопку
			const existing = document.getElementById('hh-floating-button');
			if (existing) existing.remove();

			const floatingBtn = document.createElement('button');
			floatingBtn.id = 'hh-floating-button';
			floatingBtn.textContent = STATE.uiCollapsed ? 'HH' : '×';
			floatingBtn.title = STATE.uiCollapsed ? 'Показать интерфейс' : 'Скрыть интерфейс';
			floatingBtn.style.cssText = `
				position: fixed;
				bottom: 20px;
				right: 20px;
				width: 60px;
				height: 60px;
				border-radius: 50%;
				background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
				color: white;
				border: none;
				font-size: 18px;
				font-weight: 700;
				cursor: pointer;
				z-index: 10000;
				box-shadow: 0 8px 32px rgba(59, 130, 246, 0.4);
				transition: all 0.3s ease;
				font-family: system-ui, -apple-system, sans-serif;
				display: flex;
				align-items: center;
				justify-content: center;
			`;

			floatingBtn.onmouseover = () => {
				floatingBtn.style.transform = 'scale(1.1)';
				floatingBtn.style.boxShadow = '0 12px 40px rgba(59, 130, 246, 0.6)';
			};

			floatingBtn.onmouseout = () => {
				floatingBtn.style.transform = 'scale(1)';
				floatingBtn.style.boxShadow = '0 8px 32px rgba(59, 130, 246, 0.4)';
			};

			floatingBtn.onclick = () => {
				UI.toggleFloatingUI();
			};

			document.body.appendChild(floatingBtn);
			return floatingBtn;
		},

		updateFloatingButtonText: () => {
			const floatingBtn = document.getElementById('hh-floating-button');
			if (floatingBtn) {
				floatingBtn.textContent = STATE.uiCollapsed ? 'HH' : '×';
				floatingBtn.title = STATE.uiCollapsed ? 'Показать интерфейс' : 'Скрыть интерфейс';
			}
		},
	};

	// ===== ИНИЦИАЛИЗАЦИЯ =====
	function init() {
		Utils.syncApiEndpoints();
		console.log('🚀 HH.ru Auto Responder v2.0 загружен');

		// Загружаем конфигурацию
		Utils.loadConfig();

		// Проверяем конфигурацию
		if (!CONFIG.RESUME_HASH) {
			console.warn('⚠️ ВНИМАНИЕ: RESUME_HASH не указан! Скрипт не будет работать.');
			console.log('💡 Откройте настройки (⚙️) и укажите хеш резюме');

			// Пытаемся автоматически найти RESUME_HASH
			autoFindResumeHash();
		} else {
			console.log('✅ RESUME_HASH найден');
		}

		// Создаем интерфейс
		UIBuilder.createMainInterface();

		// Показываем информацию о текущей странице
		const pageType = Utils.detectPageType();
		console.log(`📄 Тип страницы: ${pageType}`);

		if (pageType === 'vacancy') {
			const vacancyData = Utils.getCurrentVacancyData();
			if (vacancyData) {
				console.log(`🎯 Текущая вакансия: ${vacancyData.title} (ID: ${vacancyData.id})`);
				if (!Utils.hasRespondButton()) {
					console.warn('⚠️ На странице нет кнопки отклика');
				}
				if (Utils.isVacancyClosed()) {
					console.warn('⚠️ Вакансия закрыта');
				}
			} else {
				console.warn('⚠️ Не удалось определить вакансию на странице');
			}
		} else if (pageType === 'home') {
			console.log('🏠 Главная страница HH.ru');
		} else if (pageType === 'search') {
			console.log('🔍 Страница поиска вакансий');
		} else if (pageType === 'employer') {
			console.log('🏢 Страница работодателя');
		}

		// Показываем текущий RESUME_HASH
		if (CONFIG.RESUME_HASH) {
			console.log(`💼 Текущий RESUME_HASH: ${CONFIG.RESUME_HASH.substring(0, 8)}...`);
		} else {
			console.warn('⚠️ RESUME_HASH не установлен');
		}

		// Показываем статистику при загрузке
		const stats = Utils.getFormattedStats();
		if (stats.allTimeSent > 0) {
			console.log(
				`📊 Статистика: всего отправлено ${Utils.formatNumber(stats.allTimeSent)} откликов`,
			);
			UI.showNotification(
				'Добро пожаловать!',
				`Всего отправлено ${Utils.formatNumber(stats.allTimeSent)} откликов`,
				'info',
				3000,
			);
		}

		// Автосохранение конфигурации каждые 30 секунд
		// Сохраняем ID интервала для возможной очистки
		if (STATE.settings.autoSaveConfig) {
			STATE.autoSaveInterval = setInterval(() => {
				Utils.saveConfig();
			}, 30000);
		}
	}

	// Функция для автоматического поиска RESUME_HASH
	async function autoFindResumeHash() {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут
		const xsrf = Utils.getXsrfToken();

		try {
			console.log('🔍 Пытаюсь автоматически найти RESUME_HASH...');

			const response = await fetch(CONFIG.RESUMES_API, {
				credentials: 'include',
				headers: Utils.getHhApiHeaders(xsrf),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (response.ok) {
				const data = await response.json();
				const resumes = data.items || data.resumes || data.resume || [];

				if (resumes.length > 0) {
					const firstResume = resumes[0];
					const resumeHash = firstResume.hash || firstResume.resumeHash || firstResume.id;
					if (resumeHash) {
						console.log('✅ Автоматически найден RESUME_HASH:', resumeHash);
						CONFIG.RESUME_HASH = resumeHash;
						Utils.saveConfig();
						UI.showNotification('Успех!', 'RESUME_HASH найден автоматически', 'success');
						return;
					}
				}
			}

			const pageResponse = await fetch(CONFIG.RESUMES_PAGE_API, {
				credentials: 'include',
				headers: Utils.getHhApiHeaders(xsrf, {
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				}),
				signal: controller.signal,
			});

			if (pageResponse.ok) {
				const pageText = await pageResponse.text();
				const latestResumeMatch = pageText.match(/"latestResumeHash":"([a-f0-9]+)"/);
				if (latestResumeMatch) {
					console.log('✅ Автоматически найден RESUME_HASH:', latestResumeMatch[1]);
					CONFIG.RESUME_HASH = latestResumeMatch[1];
					Utils.saveConfig();
					UI.showNotification('Успех!', 'RESUME_HASH найден автоматически', 'success');
					return;
				}
			}

			console.log('❌ Не удалось автоматически найти RESUME_HASH');
			UI.showNotification(
				'Требуется настройка',
				'Не удалось найти RESUME_HASH автоматически. Откройте настройки.',
				'warning',
				6000,
			);
		} catch (error) {
			clearTimeout(timeoutId);

			// Обработка сетевых ошибок с таймаутами: fallback при автоматическом поиске резюме
			// Если не удается автоматически найти RESUME_HASH, пользователь должен указать его вручную
			let errorMsg = 'Неизвестная сетевая ошибка';
			if (error.name === 'AbortError') {
				errorMsg = 'Таймаут запроса (10 сек)';
			} else if (error.message) {
				errorMsg = error.message;
			}

			console.log(`❌ Ошибка при автоматическом поиске RESUME_HASH: ${errorMsg}`, error);
		}
	}

	// Обработка ошибок
	window.addEventListener('error', (event) => {
		console.error('Глобальная ошибка:', event.error);
		if (STATE.settings.detailedLogging) {
			Logger.saveLog({
				id: 'system',
				title: 'Системная ошибка',
				time: new Date().toISOString(),
				success: false,
				message: event.error?.message || 'Неизвестная ошибка',
			});
		}
	});

	// Запускаем инициализацию
	init();
})();
