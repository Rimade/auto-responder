(() => {
	'use strict';

	// ===== КОНФИГУРАЦИЯ =====
	const CONFIG = {
		RESUME_HASH: '', // ⚠️ ОБЯЗАТЕЛЬНО заполнить хеш резюме!
		COVER_LETTER_TEMPLATE: ``, // ЖЕЛАТЕЛЬНО написать сопроводительное письмо.

		// API endpoints
		VACANCY_API_URL: 'https://hh.ru/applicant/vacancy_response/popup',
		PUBLIC_VACANCY_API: 'https://api.hh.ru/vacancies/',
		NEGOTIATIONS_API: 'https://hh.ru/applicant/negotiations',
		RESUMES_API: 'https://hh.ru/applicant/resumes',

		// Настройки
		MAX_RESPONSES_PER_DAY: 200,
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
		settingsVisible: false,
		progressVisible: true,
		currentVacancy: null,
		consecutiveFailures: 0,
		consecutiveAlreadyApplied: 0,
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

		validateUrl: (url) => {
			try {
				const urlObj = new URL(url);
				return urlObj.hostname === 'hh.ru' || urlObj.hostname === 'www.hh.ru';
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
			if (path === '/' || path === '' || url === 'https://hh.ru/' || url === 'https://www.hh.ru/') {
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

		normalizeUrl: (url) => {
			try {
				const urlObj = new URL(url);

				// Если это главная страница, добавляем базовый поиск
				if (urlObj.pathname === '/' || urlObj.pathname === '') {
					return 'https://hh.ru/search/vacancy?text=&search_field=name&area=113&experience=doesNotMatter&order_by=publication_time&search_period=1&items_on_page=20';
				}

				// Если это не страница поиска, добавляем параметры поиска
				if (!urlObj.pathname.includes('/search/vacancy')) {
					urlObj.pathname = '/search/vacancy';
					if (!urlObj.search) {
						urlObj.search =
							'?text=&search_field=name&area=113&experience=doesNotMatter&order_by=publication_time&search_period=1&items_on_page=20';
					}
				}

				// Убеждаемся, что есть items_on_page
				if (!urlObj.searchParams.has('items_on_page')) {
					urlObj.searchParams.set('items_on_page', '20');
				}

				return urlObj.toString();
			} catch {
				return url;
			}
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
					'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT'
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

			// Ночные часы - больше задержка
			if (hour >= 23 || hour <= 6) {
				multiplier = 1.5;
			}
			// Рабочие часы - меньше задержка
			else if (hour >= 9 && hour <= 18) {
				multiplier = 0.8;
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
				const salaryValue = parsedSalary.to || parsedSalary.from;
				if (salaryValue && salaryValue < CONFIG.MIN_SALARY) {
					return {
						passed: false,
						reason: `Зарплата ниже ${Utils.formatNumber(CONFIG.MIN_SALARY)}`,
					};
				}
			}

			if (CONFIG.MAX_SALARY > 0) {
				const salaryValue = parsedSalary.from || parsedSalary.to;
				if (salaryValue && salaryValue > CONFIG.MAX_SALARY) {
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
				companyName.toLowerCase().includes(blacklisted.toLowerCase())
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
					text.includes(keyword.toLowerCase())
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
					text.includes(keyword.toLowerCase())
				);
				if (hasExcluded) {
					const excludedWord = CONFIG.EXCLUDED_KEYWORDS.find((keyword) =>
						text.includes(keyword.toLowerCase())
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

			// Обновляем прогресс
			ProgressTracker.update();
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
			const logs = Logger.getLogs();
			const today = new Date().toDateString();
			return logs.filter((log) => log.success && new Date(log.time).toDateString() === today)
				.length;
		},
	};

	// ===== ТРЕКЕР ПРОГРЕССА =====
	const ProgressTracker = {
		update: () => {
			if (!STATE.progressVisible) return;

			try {
				const progressBar = document.getElementById('hh-progress-bar');
				if (!progressBar) return;

				const stats = Utils.getFormattedStats();
				const percentage =
					STATE.totalProcessed > 0
						? Math.round((STATE.responsesCount / STATE.totalProcessed) * 100)
						: 0;

				// Обновляем текст в progress-text-left (в HTML это .progress-text-left)
				const progressTextLeft = progressBar.querySelector('.progress-text-left');
				if (progressTextLeft) {
					progressTextLeft.textContent = `${stats.totalSent} / ${stats.totalProcessed} (${percentage}%)`;
				}

				// Обновляем все элементы прогресс-бара
				const progressFill = progressBar.querySelector('.progress-fill');
				const progressText = progressBar.querySelector('.progress-text');
				const progressBadge = progressBar.querySelector('.progress-badge');
				const progressTxtSent = progressBar.querySelector('.progress-txt-sent');
				const progressTxtSkipped = progressBar.querySelector('.progress-txt-skipped');
				const progressTxtErrors = progressBar.querySelector('.progress-txt-errors');
				const progressTxtRuntime = progressBar.querySelector('.progress-txt-runtime');

				if (progressFill) progressFill.style.width = `${Math.min(percentage, 100)}%`;
				if (progressText)
					progressText.textContent = `${stats.totalSent}/${stats.totalProcessed} (${stats.successRate}%)`;
				if (progressBadge) progressBadge.textContent = `${percentage}%`;
				if (progressTxtSent) progressTxtSent.textContent = stats.totalSent;
				if (progressTxtSkipped) progressTxtSkipped.textContent = stats.totalSkipped;
				if (progressTxtErrors) progressTxtErrors.textContent = stats.totalErrors;
				if (progressTxtRuntime) progressTxtRuntime.textContent = stats.runningTime;
			} catch (error) {
				console.error('Ошибка обновления прогресса:', error);
			}
		},

		create: () => {
			const existing = document.getElementById('hh-progress-bar');
			if (existing) return existing;

			const progressBar = document.createElement('div');
			progressBar.id = 'hh-progress-bar';
			progressBar.style.cssText = `
				position: fixed;
				top: 32px;
				left: 50%;
				transform: translateX(-50%);
				width: 430px;
				height: 84px;
				background: rgba(248, 250, 252, 1);
				border-radius: 16px;
				box-shadow: 0 8px 32px rgba(16, 185, 129, 0.09), 0 2px 2px rgba(0,0,0,.03);
				border: 1px solid #e5e7eb;
				z-index: 10003;
				padding: 18px 22px 14px 22px;
				display: ${STATE.progressVisible ? 'block' : 'none'};
				backdrop-filter: blur(10px);
				transition: box-shadow .25s;
				font-family: "Segoe UI", system-ui, sans-serif;
			`;

			progressBar.innerHTML = `
				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
					<span style="font-size: 16px; font-weight: 700; color: #059669; letter-spacing:0.01em;">${'📊 '}Прогресс откликов</span>
					<button id="progress-close" title="Скрыть" style="background: none; border: none; font-size: 22px; line-height:1; cursor: pointer; color: #9CA3AF; transition: color .16s;">×</button>
				</div>
				<div style="display: flex; align-items: center; gap: 10px;">
					<div style="flex:1;">
						<div style="width: 100%; height: 22px; background: #f3f4f6; border-radius: 11px; overflow: hidden; position:relative;">
							<div class="progress-fill"
								style="height: 100%; background: linear-gradient(90deg, #10b981 0%, #059669 100%); width: 0%; min-width: 4%; transition: width 0.45s cubic-bezier(.4,2,.6,1);"></div>
						</div>
						<div style="display:flex; justify-content:space-between; margin-top:2px;">
							<div class="progress-text-left" style="font-size:11px; color:#64748b;">0 / 0 (${0}%)</div>
							<div class="progress-text-right" style="font-size:11px; color:#64748b;"></div>
						</div>
					</div>
					<div style="flex: none; width: 60px; text-align: right;">
						<div class="progress-badge" style="
							display:inline-block;
							background: #ecfdf5;
							color: #059669;
							font-weight: bold;
							font-size: 13px;
							border-radius: 7px;
							padding: 2px 10px;
							border: 1px solid #d1fae5;
							box-shadow:0 2px 4px rgba(16,185,129,.07);
							letter-spacing:0.02em;
							">0%</div>
					</div>
				</div>
				<div style="margin-top: 7px; display:flex; gap:16px; align-items: center; font-size:11.5px; color: #6b7280;">
					<div class="progress-detail-sent" title="Отправлено" style="display:flex;align-items:center;gap:3px;">
						<span style="color:#059669;font-size:13px;">⬆️</span> <span class="progress-txt-sent">0</span> откликов
					</div>
					<div class="progress-detail-skipped" title="Пропущено" style="display:flex;align-items:center;gap:3px;">
						<span style="color:#a8a29e;font-size:13px;">⏭️</span> <span class="progress-txt-skipped">0</span> пропущено
					</div>
					<div class="progress-detail-errors" title="Ошибок" style="display:flex;align-items:center;gap:3px;">
						<span style="color:#ef4444;font-size:13px;">⛔</span> <span class="progress-txt-errors">0</span> ошибок
					</div>
					<div class="progress-detail-time" title="Время работы" style="margin-left:auto; font-variant-numeric: tabular-nums;">
						🕒 <span class="progress-txt-runtime">00:00</span>
					</div>
				</div>
			`;

			progressBar.querySelector('#progress-close').onclick = () => {
				STATE.progressVisible = false;
				progressBar.style.display = 'none';
			};

			document.body.appendChild(progressBar);
			return progressBar;
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
							background: none;
							border: none;
							font-size: 24px;
							cursor: pointer;
							color: #64748b;
							padding: 8px;
							border-radius: 8px;
							transition: all 0.2s ease;
							line-height: 1;
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
						.current-status {
							background: #fef3c7;
							color: #92400e;
							padding: 8px 12px;
							border-radius: 8px;
							font-size: 12px;
							font-weight: 600;
							margin-bottom: 16px;
							text-align: center;
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
						<h3 class="modal-title">📤 Отправленные отклики</h3>
						<button class="modal-close">×</button>
					</div>
					<div id="current-status" class="current-status" style="display: none;"></div>
					<ul class="log-list"></ul>
					<div class="stats-container">
						<div class="stats-title">📊 Статистика</div>
						<div class="stats-grid"></div>
					</div>
				`;

				modal.querySelector('.modal-close').onclick = () => {
					STATE.modalVisible = false;
					modal.style.display = 'none';
				};

				document.body.appendChild(modal);
			} else {
				modal.style.display = STATE.modalVisible ? 'block' : 'none';
			}
			return modal;
		},

		updateModal: (entry) => {
			const modal = UI.createModal();
			const list = modal.querySelector('.log-list');
			const statsGrid = modal.querySelector('.stats-grid');
			const statusDiv = modal.querySelector('#current-status');

			if (!list) return;

			// Обновляем текущий статус
			try {
				if (statusDiv) {
					if (STATE.isRunning) {
						statusDiv.style.display = 'block';
						statusDiv.innerHTML = STATE.isPaused
							? '⏸️ Приостановлено'
							: `🔄 Обрабатывается: ${STATE.currentVacancy || 'загрузка...'}`;
					} else {
						statusDiv.style.display = 'none';
					}
				}
			} catch (error) {
				console.error('Ошибка обновления статуса:', error);
			}

			// Добавляем новую запись
			try {
				if (entry) {
					const li = document.createElement('li');
					li.className = 'log-item';

					const symbol = entry.success ? '✅' : '❌';
					const a = document.createElement('a');
					a.className = 'log-link';
					a.href = `https://hh.ru/vacancy/${entry.id}`;
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
							<span class="stats-label">Сегодня отправлено:</span>
							<span class="stats-value">${Responses.getSentToday()}</span>
						</div>
					`;
				}
			} catch (error) {
				console.error('Ошибка обновления статистики:', error);
			}
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
			if (uiContainer && floatingBtn) {
				STATE.uiCollapsed = !STATE.uiCollapsed;
				uiContainer.style.display = STATE.uiCollapsed ? 'none' : 'flex';

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
				overflow-y: auto;
				background: white;
				border-radius: 20px;
				box-shadow: 0 25px 80px rgba(0, 0, 0, 0.2);
				z-index: 10005;
				font-family: system-ui, -apple-system, sans-serif;
				display: ${STATE.settingsVisible ? 'block' : 'none'};
			`;

			panel.innerHTML = `
				<div style="padding: 32px;">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px;">
						<h2 style="margin: 0; font-size: 24px; font-weight: 700; color: #1e293b;">⚙️ Настройки</h2>
						<button id="settings-close" style="background: none; border: none; font-size: 28px; cursor: pointer; color: #64748b; padding: 8px; border-radius: 8px;">×</button>
					</div>

					<div style="display: grid; gap: 24px;">
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

						<!-- Хеш резюме -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Хеш резюме</h3>
							<input type="text" id="setting-resume-hash" value="${
								CONFIG.RESUME_HASH
							}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="Введите хеш вашего резюме">
						</div>

						<!-- Сопроводительное письмо -->
						<div>
							<h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #374151;">Сопроводительное письмо</h3>
							<textarea id="setting-cover-letter" style="width: 100%; height: 120px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; resize: vertical;" placeholder="Используйте {#vacancyName} для подстановки названия вакансии">${
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
										', '
									)}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="React, JavaScript, Frontend">
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; font-weight: 500;">Исключающие слова (через запятую):</label>
									<input type="text" id="setting-excluded-keywords" value="${CONFIG.EXCLUDED_KEYWORDS.join(
										', '
									)}" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;" placeholder="PHP, Java, Backend">
								</div>
								<div>
									<label style="display: block; margin-bottom: 4px; font-weight: 500;">Черный список компаний (через запятую):</label>
									<input type="text" id="setting-blacklist" value="${CONFIG.BLACKLIST_COMPANIES.join(
										', '
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
			panel.querySelector('#settings-close').onclick = () => {
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
			return panel;
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
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

		try {
			const res = await fetch(CONFIG.PUBLIC_VACANCY_API + vacancyId, {
				headers: {
					'User-Agent': navigator.userAgent,
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const errorMsg = `HTTP ${res.status} ${res.statusText}`;
				console.error(`❌ Сетевая ошибка при проверке вакансии ${vacancyId}: ${errorMsg}`);
				return { error: true, message: errorMsg };
			}

			const data = await res.json();

			// Проверяем статус вакансии
			if (data.archived) {
				return { error: true, message: 'Архивирована' };
			}

			// Проверяем требования к тесту
			if (data.test?.required) {
				return { error: true, message: 'Требуется тест' };
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

		try {
			// Проверяем, не отправляли ли уже отклик
			if (STATE.settings.skipDuplicates && Responses.isAlreadyResponded(vacancyId)) {
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: false,
					message: 'Дубликат',
				});
				STATE.totalSkipped++;
				STATE.currentVacancy = null; // Сбрасываем текущую вакансию при пропуске дубликата
				return;
			}

			// Проверяем статус вакансии
			const statusCheck = await checkVacancyStatus(vacancyId);
			if (statusCheck.error) {
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
			form.append('incomplete', 'false');
			form.append('mark_applicant_visible_in_vacancy_country', 'false');
			form.append('lux', 'true');
			form.append('withoutTest', 'no');
			form.append('hhtmFromLabel', '');
			form.append('hhtmSourceLabel', '');

			const coverLetter = CONFIG.COVER_LETTER_TEMPLATE.replace('{#vacancyName}', title);
			form.append('letter', coverLetter);

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

			const res = await fetch(CONFIG.VACANCY_API_URL, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'x-xsrftoken': xsrf,
					'x-requested-with': 'XMLHttpRequest',
					'User-Agent': navigator.userAgent,
				},
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
							6000
						);
						STATE.currentVacancy = null; // Сбрасываем текущую вакансию при остановке
						stopProcess();
					} else {
						STATE.currentVacancy = null; // Сбрасываем текущую вакансию после обработки Already applied
					}
					return;
				} else if (retryCount < CONFIG.MAX_RETRIES) {
					// Логика повторных попыток: при сетевых ошибках делаем повторные попытки с фиксированной задержкой
					// Это fallback-механизм для временных проблем с сетью или сервером
					console.log(
						`Повторная попытка ${retryCount + 1}/${CONFIG.MAX_RETRIES} для вакансии ${vacancyId}`
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
					`Повторная попытка ${retryCount + 1}/${CONFIG.MAX_RETRIES} для вакансии ${vacancyId}`
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
		let pageUrl = Utils.normalizeUrl(url);
		pageUrl = pageUrl.includes('?') ? `${pageUrl}&page=${pageNum}` : `${pageUrl}?page=${pageNum}`;

		console.log(`📄 Обрабатываю страницу ${pageNum + 1}: ${pageUrl}`);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

		try {
			const res = await fetch(pageUrl, {
				credentials: 'include',
				headers: {
					'User-Agent': navigator.userAgent,
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!res.ok) {
				const errorMsg = `HTTP ${res.status} ${res.statusText}`;
				console.error(`❌ Ошибка загрузки страницы ${pageNum + 1}: ${errorMsg}`);
				return false;
			}

			const text = await res.text();
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
					.map((link) => link.closest('[data-qa*="vacancy"]') || link.closest('.vacancy-serp-item'))
					.filter(Boolean);
			}

			if (cards.length === 0) {
				console.log('🔚 Вакансии на странице не найдены. Завершаю обработку.');
				return false;
			}

			console.log(`📋 Найдено ${cards.length} вакансий на странице ${pageNum + 1}`);

			let processedOnPage = 0;
			let successfulOnPage = 0;

			for (let i = 0; i < cards.length; i++) {
				const card = cards[i];

				// Проверяем условия остановки
				if (!STATE.isRunning || STATE.responsesCount >= CONFIG.MAX_RESPONSES_PER_DAY) {
					console.log(
						`🛑 Остановка: isRunning=${STATE.isRunning}, responses=${STATE.responsesCount}/${CONFIG.MAX_RESPONSES_PER_DAY}`
					);
					break;
				}

				// Проверяем паузу
				while (STATE.isPaused && STATE.isRunning) {
					await Utils.delay(1000);
				}

				if (!STATE.isRunning) break;

				// Извлекаем данные вакансии
				const vacancyData = extractVacancyData(card);
				if (!vacancyData) {
					console.log(`⚠️ Не удалось извлечь данные вакансии ${i + 1}`);
					continue;
				}

				console.log(
					`🔍 Обрабатываю вакансию ${i + 1}/${cards.length}: ${vacancyData.title} (ID: ${
						vacancyData.id
					})`
				);

				STATE.totalProcessed++;
				processedOnPage++;

				// Применяем фильтры
				const filterResult = Filters.shouldSkipVacancy(vacancyData);
				if (filterResult.skip) {
					console.log(
						`⏭️ Пропускаю вакансию ${vacancyData.id}: ${filterResult.reasons.join(', ')}`
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
				if (i < cards.length - 1) {
					// Не делаем задержку после последней вакансии
					let delay = Utils.getSmartDelay();

					// Логика экспоненциальной задержки: при последовательных неудачах увеличиваем задержку
					// Это предотвращает перегрузку сервера и дает время на восстановление
					// Формула: 2^(failures-1) * 1000мс = 1с, 2с, 4с, 8с, 16с... при 1,2,3,4... неудачах
					if (STATE.consecutiveFailures > 0) {
						const exponentialDelay = Math.pow(2, STATE.consecutiveFailures - 1) * 1000; // 1с, 2с, 4с, 8с...
						delay = Math.max(delay, exponentialDelay);
						console.log(
							`⚠️ Экспоненциальная задержка ${exponentialDelay}мс из-за ${STATE.consecutiveFailures} подряд неудач`
						);
					}

					console.log(`⏳ Задержка ${delay}мс перед следующей вакансией...`);
					await Utils.randomDelay(delay * 0.8, delay * 1.2);
				}
			}

			console.log(
				`📊 Страница ${
					pageNum + 1
				} завершена: обработано ${processedOnPage}, отправлено ${successfulOnPage}`
			);

			// Возвращаем true только если обработали хотя бы одну вакансию
			return processedOnPage > 0;
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

		const title = link?.innerText?.trim();
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
		const salaryElement = card.querySelector('[data-qa="vacancy-serp__vacancy-compensation"]');
		const salary = salaryElement?.innerText?.trim() || '';

		const companyElement = card.querySelector('[data-qa="vacancy-serp__vacancy-employer"]');
		const company = companyElement?.innerText?.trim() || '';

		const descriptionElement = card.querySelector(
			'[data-qa="vacancy-serp__vacancy_snippet_requirement"]'
		);
		const description = descriptionElement?.innerText?.trim() || '';

		return {
			id: vacancyId,
			title,
			salary,
			company,
			description,
			href,
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

		while (
			hasMorePages &&
			STATE.isRunning &&
			STATE.responsesCount < CONFIG.MAX_RESPONSES_PER_DAY &&
			pageNum < maxPages
		) {
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
					} не обработана. Ошибок подряд: ${consecutiveErrors}, пустых страниц: ${consecutiveEmptyPages}`
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
			if (STATE.responsesCount >= CONFIG.MAX_RESPONSES_PER_DAY) {
				console.log('🔚 Достигнут дневной лимит откликов.');
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
			`🏁 Обработка завершена. Всего страниц: ${pageNum}, откликов: ${STATE.responsesCount}`
		);

		if (STATE.responsesCount >= CONFIG.MAX_RESPONSES_PER_DAY) {
			console.log('🔚 Достигнут дневной лимит откликов.');
		} else {
			console.log('✅ Все доступные страницы обработаны!');
		}

		stopProcess();
	}

	// ===== УПРАВЛЕНИЕ ПРОЦЕССОМ =====
	function stopProcess() {
		STATE.isRunning = false;
		STATE.isPaused = false;
		STATE.currentVacancy = null;

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
			6000
		);

		// Скрываем прогресс-бар
		const progressBar = document.getElementById('hh-progress-bar');
		if (progressBar) {
			setTimeout(() => {
				progressBar.style.display = 'none';
			}, 3000);
		}
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
			'info'
		);
	}

	function startProcess(url) {
		// Проверяем RESUME_HASH
		if (!CONFIG.RESUME_HASH) {
			UI.showNotification(
				'Ошибка конфигурации',
				'Не указан RESUME_HASH! Откройте настройки и укажите хеш резюме.',
				'error',
				8000
			);
			return;
		}

		// Определяем тип страницы
		const pageType = Utils.detectPageType();

		// Для главной страницы - нормализуем URL для обработки вакансий
		if (pageType === 'home') {
			url = Utils.normalizeUrl(url);
		}

		// Для страницы вакансии - одиночный отклик
		if (pageType === 'vacancy') {
			startSingleVacancyProcess();
			return;
		}

		// Проверяем дневной лимит
		const sentToday = Responses.getSentToday();
		if (sentToday >= CONFIG.MAX_RESPONSES_PER_DAY) {
			UI.showNotification(
				'Лимит превышен',
				`Сегодня уже отправлено ${sentToday} откликов. Дневной лимит: ${CONFIG.MAX_RESPONSES_PER_DAY}`,
				'warning',
				6000
			);
			return;
		}

		console.log('✅ Начинаю обработку вакансий...');
		console.log('🔍 URL для обработки:', url);

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

		// Показываем прогресс и модальное окно
		ProgressTracker.create();
		UI.openModal();

		UI.showNotification('Запущено', 'Начинаю отправку откликов', 'success');
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
				'warning'
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
				6000
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

		// Показываем прогресс
		ProgressTracker.create();
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
			const input = UIBuilder.createUrlInput();
			const mainButton = UIBuilder.createMainButton();
			const pauseButton = UIBuilder.createPauseButton();
			const controlButtons = UIBuilder.createControlButtons();

			uiContainer.appendChild(input);
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

		createUrlInput: () => {
			const pageType = Utils.detectPageType();
			let placeholder = 'Вставьте ссылку с HH.ru или оставьте пустым для общего поиска';
			let isDisabled = false;

			if (pageType === 'vacancy') {
				const vacancyData = Utils.getCurrentVacancyData();
				if (vacancyData) {
					placeholder = `Текущая вакансия: ${vacancyData.title}`;
					isDisabled = true;
				} else {
					placeholder = 'Не удалось определить вакансию на странице';
					isDisabled = true;
				}
			} else if (pageType === 'search') {
				placeholder = 'Оставьте пустым для обработки текущего поиска или вставьте другую ссылку';
			} else if (pageType === 'employer') {
				placeholder =
					'Оставьте пустым для обработки вакансий работодателя или вставьте другую ссылку';
			}

			const input = document.createElement('input');
			input.type = 'text';
			input.id = 'hh-api-filter-url';
			input.placeholder = placeholder;
			input.disabled = isDisabled;
			input.style.cssText = `
				width: 100%;
				padding: 16px 20px;
				border-radius: 12px;
				border: 2px solid #e5e7eb;
				font-family: inherit;
				font-size: 14px;
				background: ${isDisabled ? '#f9fafb' : '#fff'};
				box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
				transition: all 0.3s ease;
				outline: none;
				box-sizing: border-box;
				cursor: ${isDisabled ? 'not-allowed' : 'text'};
			`;

			input.onfocus = () => {
				if (!isDisabled) {
					input.style.borderColor = '#3b82f6';
					input.style.boxShadow = '0 0 0 4px rgba(59, 130, 246, 0.1)';
				}
			};

			input.onblur = () => {
				if (!isDisabled) {
					const storedUrl = localStorage.getItem(CONFIG.FILTER_URL_KEY);
					input.style.borderColor = input.value === storedUrl ? '#10b981' : '#e5e7eb';
					input.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.05)';
				}
			};

			// Автосохранение с debounce (только если не disabled)
			if (!isDisabled) {
				const saveUrl = Utils.debounce(() => {
					localStorage.setItem(CONFIG.FILTER_URL_KEY, input.value);
					input.style.borderColor = '#10b981';
				}, 500);

				input.oninput = saveUrl;

				// Загружаем сохраненный URL
				const storedUrl = localStorage.getItem(CONFIG.FILTER_URL_KEY);
				if (storedUrl) {
					input.value = storedUrl;
					input.style.borderColor = '#10b981';
				}
			} else {
				// Для disabled поля показываем текущий URL
				input.value = window.location.href;
				input.style.borderColor = '#10b981';
			}

			return input;
		},

		createMainButton: () => {
			const pageType = Utils.detectPageType();
			let buttonText = '📤 Отправить отклики';
			let buttonHint = 'Оставьте поле пустым для общего поиска или вставьте ссылку с HH.ru';

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
			} else {
				buttonText = '📤 Отправить отклики';
				buttonHint = 'Оставьте поле пустым для общего поиска или вставьте ссылку с HH.ru';
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

				// Для страницы вакансии не проверяем URL
				if (pageType === 'vacancy') {
					startProcess(window.location.href);
					return;
				}

				let url = document.getElementById('hh-api-filter-url').value.trim();

				// Если URL пустой, используем текущий URL или базовый поиск
				if (!url) {
					if (pageType === 'search' || pageType === 'employer') {
						url = window.location.href;
					} else {
						url = 'https://hh.ru/search/vacancy';
					}
				}

				if (!Utils.validateUrl(url)) {
					UI.showNotification('Ошибка', 'Неверный URL! Введите корректную ссылку с HH.ru', 'error');
					return;
				}

				startProcess(url);
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
		console.log('🚀 HH.ru Auto Responder v3.0 загружен');

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
				`📊 Статистика: всего отправлено ${Utils.formatNumber(stats.allTimeSent)} откликов`
			);
			UI.showNotification(
				'Добро пожаловать!',
				`Всего отправлено ${Utils.formatNumber(stats.allTimeSent)} откликов`,
				'info',
				3000
			);
		}

		// Автосохранение конфигурации каждые 30 секунд
		if (STATE.settings.autoSaveConfig) {
			setInterval(() => {
				Utils.saveConfig();
			}, 30000);
		}
	}

	// Функция для автоматического поиска RESUME_HASH
	async function autoFindResumeHash() {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

		try {
			console.log('🔍 Пытаюсь автоматически найти RESUME_HASH...');

			const response = await fetch(CONFIG.RESUMES_API, {
				credentials: 'include',
				headers: {
					Accept: 'application/json',
					'User-Agent': navigator.userAgent,
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (response.ok) {
				const data = await response.json();
				if (data.items && data.items.length > 0) {
					const firstResume = data.items[0];
					if (firstResume.hash) {
						console.log('✅ Автоматически найден RESUME_HASH:', firstResume.hash);
						CONFIG.RESUME_HASH = firstResume.hash;
						Utils.saveConfig();
						UI.showNotification('Успех!', 'RESUME_HASH найден автоматически', 'success');
						return;
					}
				}
			}

			console.log('❌ Не удалось автоматически найти RESUME_HASH');
			UI.showNotification(
				'Требуется настройка',
				'Не удалось найти RESUME_HASH автоматически. Откройте настройки.',
				'warning',
				6000
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
