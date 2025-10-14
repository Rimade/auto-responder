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

		// Новые настройки фильтрации
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
		responsesCount: 0,
		currentPage: 0,
		totalProcessed: 0,
		totalSkipped: 0,
		startTime: null,
		uiCollapsed: false,
		modalVisible: true,
		settings: {
			autoFindResume: true,
			showNotifications: true,
			soundEnabled: true,
			darkMode: false,
			enableFilters: true,
			pauseOnError: false,
		},
	};

	// ===== УТИЛИТЫ =====
	const Utils = {
		delay: (ms) => new Promise((res) => setTimeout(res, ms)),

		randomDelay: (min, max) => Utils.delay(Math.random() * (max - min) + min),

		validateUrl: (url) => {
			try {
				const urlObj = new URL(url);
				// Принимаем любые URL с HH.ru
				return urlObj.hostname === 'hh.ru';
			} catch {
				return false;
			}
		},

		getXsrfToken: () => {
			return document.cookie.match(/_xsrf=([^;]+)/)?.[1] || '';
		},

		normalizeUrl: (url) => {
			// Преобразуем URL в формат поиска вакансий
			try {
				const urlObj = new URL(url);

				// Если это главная страница, добавляем базовый поиск
				if (urlObj.pathname === '/' || urlObj.pathname === '') {
					return 'https://hh.ru/search/vacancy?text=Frontend&search_field=name&area=113&experience=doesNotMatter&order_by=relevance&search_period=7&items_on_page=20';
				}

				// Если это не страница поиска, добавляем параметры поиска
				if (!urlObj.pathname.includes('/search/vacancy')) {
					urlObj.pathname = '/search/vacancy';
					urlObj.search =
						'?text=Frontend&search_field=name&area=113&experience=doesNotMatter&order_by=relevance&search_period=7&items_on_page=20';
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

		playNotificationSound: () => {
			if (!STATE.settings.soundEnabled) return;

			try {
				const audio = new Audio(
					'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT'
				);
				audio.play();
			} catch (e) {
				console.log('Не удалось воспроизвести звук');
			}
		},

		// Улучшенная функция для получения статистики
		getFormattedStats: () => {
			const stats = Logger.getStats();
			const sentCount = Responses.getSentCount();
			const runningTime = stats.runningTime ? Math.floor(stats.runningTime / 1000) : 0;

			return {
				totalSent: stats.totalSent || 0,
				totalProcessed: stats.totalProcessed || 0,
				totalSkipped: stats.totalSkipped || 0,
				allTimeSent: sentCount,
				runningTime: Utils.formatTime(runningTime * 1000),
				successRate:
					stats.totalProcessed > 0 ? Math.round((stats.totalSent / stats.totalProcessed) * 100) : 0,
			};
		},

		// Новая функция для парсинга зарплаты
		parseSalary: (salaryText) => {
			if (!salaryText) return null;

			const cleanText = salaryText.replace(/\s/g, '').replace(/₽|руб/g, '');
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

		// Функция сохранения конфигурации
		saveConfig: () => {
			localStorage.setItem(CONFIG.CONFIG_KEY, JSON.stringify(CONFIG));
		},

		// Функция загрузки конфигурации
		loadConfig: () => {
			const saved = localStorage.getItem(CONFIG.CONFIG_KEY);
			if (saved) {
				const savedConfig = JSON.parse(saved);
				Object.assign(CONFIG, savedConfig);
			}
		},
	};

	// ===== ФИЛЬТРЫ =====
	const Filters = {
		checkSalary: (salary) => {
			if (!STATE.settings.enableFilters) return true;

			if (!salary && CONFIG.SKIP_WITHOUT_SALARY) {
				return false;
			}

			if (!salary) return true;

			const parsedSalary = Utils.parseSalary(salary);
			if (!parsedSalary) return true;

			if (CONFIG.MIN_SALARY > 0) {
				const salaryValue = parsedSalary.to || parsedSalary.from;
				if (salaryValue && salaryValue < CONFIG.MIN_SALARY) {
					return false;
				}
			}

			if (CONFIG.MAX_SALARY > 0) {
				const salaryValue = parsedSalary.from || parsedSalary.to;
				if (salaryValue && salaryValue > CONFIG.MAX_SALARY) {
					return false;
				}
			}

			return true;
		},

		checkCompany: (companyName) => {
			if (!STATE.settings.enableFilters || !companyName) return true;

			return !CONFIG.BLACKLIST_COMPANIES.some((blacklisted) =>
				companyName.toLowerCase().includes(blacklisted.toLowerCase())
			);
		},

		checkKeywords: (title, description = '') => {
			if (!STATE.settings.enableFilters) return true;

			const text = (title + ' ' + description).toLowerCase();

			// Проверяем обязательные ключевые слова
			if (CONFIG.REQUIRED_KEYWORDS.length > 0) {
				const hasRequired = CONFIG.REQUIRED_KEYWORDS.some((keyword) =>
					text.includes(keyword.toLowerCase())
				);
				if (!hasRequired) return false;
			}

			// Проверяем исключающие ключевые слова
			if (CONFIG.EXCLUDED_KEYWORDS.length > 0) {
				const hasExcluded = CONFIG.EXCLUDED_KEYWORDS.some((keyword) =>
					text.includes(keyword.toLowerCase())
				);
				if (hasExcluded) return false;
			}

			return true;
		},

		shouldSkipVacancy: (vacancyData) => {
			const reasons = [];

			if (!Filters.checkSalary(vacancyData.salary)) {
				reasons.push('зарплата не соответствует критериям');
			}

			if (!Filters.checkCompany(vacancyData.company)) {
				reasons.push('компания в черном списке');
			}

			if (!Filters.checkKeywords(vacancyData.title, vacancyData.description)) {
				reasons.push('не соответствует ключевым словам');
			}

			return reasons.length > 0 ? reasons : null;
		},
	};

	// ===== ЛОГИРОВАНИЕ И СТАТИСТИКА =====
	const Logger = {
		saveLog: (entry) => {
			const log = JSON.parse(localStorage.getItem(CONFIG.LOG_KEY) || '[]');
			log.push(entry);
			if (log.length > 100) log.shift();
			localStorage.setItem(CONFIG.LOG_KEY, JSON.stringify(log));
			UI.updateModal(entry);
			Logger.updateStats();

			// Воспроизводим звук при успешном отклике
			if (entry.success) {
				Utils.playNotificationSound();
			}
		},

		updateStats: () => {
			const stats = {
				totalSent: STATE.responsesCount,
				totalProcessed: STATE.totalProcessed,
				lastRun: new Date().toISOString(),
				runningTime: STATE.startTime ? Date.now() - STATE.startTime : 0,
			};
			localStorage.setItem(CONFIG.STATS_KEY, JSON.stringify(stats));
		},

		getStats: () => {
			return JSON.parse(localStorage.getItem(CONFIG.STATS_KEY) || '{}');
		},

		exportLogs: () => {
			const log = JSON.parse(localStorage.getItem(CONFIG.LOG_KEY) || '[]');
			const stats = Logger.getStats();

			const exportData = {
				timestamp: new Date().toISOString(),
				stats: stats,
				log: log,
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
	};

	// ===== УПРАВЛЕНИЕ ОТКЛИКАМИ =====
	const Responses = {
		isAlreadyResponded: (vacancyId) => {
			const sentResponses = JSON.parse(localStorage.getItem(CONFIG.SENT_RESPONSES_KEY) || '[]');
			return sentResponses.includes(vacancyId);
		},

		markAsResponded: (vacancyId) => {
			const sentResponses = JSON.parse(localStorage.getItem(CONFIG.SENT_RESPONSES_KEY) || '[]');
			if (!sentResponses.includes(vacancyId)) {
				sentResponses.push(vacancyId);
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
					width: 420px;
					max-height: 500px;
					overflow-y: auto;
					background: rgba(255, 255, 255, 0.98);
					border: 1px solid #e0e0e0;
					border-radius: 16px;
					box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
					z-index: 10001;
					font-family: system-ui, -apple-system, sans-serif;
					padding: 20px;
					display: ${STATE.modalVisible ? 'block' : 'none'};
					backdrop-filter: blur(12px);
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
						#hh-api-modal-header {
							display: flex;
							justify-content: space-between;
							align-items: center;
							margin-bottom: 16px;
							padding-bottom: 12px;
							border-bottom: 2px solid #f1f5f9;
						}
						#hh-api-modal-title {
							font-size: 18px;
							font-weight: 600;
							color: #1e293b;
							margin: 0;
						}
						#hh-api-modal-close {
							background: none;
							border: none;
							font-size: 20px;
							cursor: pointer;
							color: #64748b;
							padding: 4px;
							border-radius: 4px;
							transition: all 0.2s ease;
						}
						#hh-api-modal-close:hover {
							background: #f1f5f9;
							color: #1e293b;
						}
						#hh-api-modal-list {
							list-style: none;
							padding: 0;
							margin: 0;
						}
						#hh-api-modal-list li {
							display: flex;
							align-items: flex-start;
							padding: 12px 0;
							border-bottom: 1px solid #f1f5f9;
							transition: background 0.2s ease;
						}
						#hh-api-modal-list li:hover {
							background: #f8fafc;
							margin: 0 -8px;
							padding: 12px 8px;
							border-radius: 8px;
						}
						#hh-api-modal-list li:last-child {
							border-bottom: none;
						}
						#hh-api-modal-list a {
							color: #1e40af;
							text-decoration: none;
							font-size: 14px;
							flex: 1;
							transition: color 0.2s ease;
							line-height: 1.4;
						}
						#hh-api-modal-list a:hover {
							color: #1d4ed8;
						}
						#hh-api-modal-list span.symbol {
							font-size: 18px;
							margin-right: 12px;
							margin-top: 2px;
						}
						#hh-api-modal-list span.time {
							font-size: 12px;
							color: #64748b;
							margin-left: 8px;
							white-space: nowrap;
						}
						#hh-api-stats {
							margin-top: 16px;
							padding: 12px;
							background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
							border-radius: 12px;
							font-size: 13px;
							color: #475569;
							border: 1px solid #e2e8f0;
						}
						#hh-api-stats-grid {
							display: grid;
							grid-template-columns: 1fr 1fr;
							gap: 8px;
							margin-top: 8px;
						}
						#hh-api-stats-item {
							display: flex;
							justify-content: space-between;
							align-items: center;
							padding: 4px 0;
						}
						#hh-api-stats-label {
							font-weight: 500;
							color: #374151;
						}
						#hh-api-stats-value {
							font-weight: 600;
							color: #1e40af;
						}
						@media (max-width: 600px) {
							#hh-api-modal {
								width: 90%;
								right: 5%;
								bottom: 120px;
							}
						}
					</style>
					<div id="hh-api-modal-header">
						<h3 id="hh-api-modal-title">📤 Отправленные отклики</h3>
						<button id="hh-api-modal-close">×</button>
					</div>
					<ul id="hh-api-modal-list"></ul>
					<div id="hh-api-stats"></div>
				`;

				// Обработчик скрытия: обновляем только отображение, не удаляем возможность открытия снова
				modal.querySelector('#hh-api-modal-close').onclick = () => {
					STATE.modalVisible = false;
					modal.style.display = 'none';
				};

				document.body.appendChild(modal);
			} else {
				// Обновляем видимость при повторных вызовах
				modal.style.display = STATE.modalVisible ? 'block' : 'none';
			}
			return modal;
		},

		updateModal: (entry) => {
			const modal = UI.createModal();
			const list = modal.querySelector('#hh-api-modal-list');
			const statsDiv = modal.querySelector('#hh-api-stats');

			if (!list) return;

			// Добавляем новую запись
			if (entry) {
				const fragment = document.createDocumentFragment();
				const li = document.createElement('li');
				const symbol = entry.success ? '✅' : '❌';
				const a = document.createElement('a');
				a.href = `https://hh.ru/vacancy/${entry.id}`;
				a.textContent = entry.title + (entry.message ? ` (${entry.message})` : '');
				a.target = '_blank';
				a.style.display = 'inline-block';

				const timeSpan = document.createElement('span');
				timeSpan.className = 'time';
				timeSpan.textContent = new Date(entry.time).toLocaleTimeString();

				const symbolSpan = document.createElement('span');
				symbolSpan.className = 'symbol';
				symbolSpan.textContent = symbol;

				li.appendChild(symbolSpan);
				li.appendChild(a);
				li.appendChild(timeSpan);
				fragment.appendChild(li);
				list.insertBefore(fragment, list.firstChild);

				// Ограничиваем количество записей
				while (list.children.length > 10) {
					list.removeChild(list.lastChild);
				}
			}

			// Обновляем статистику
			if (statsDiv) {
				const formattedStats = Utils.getFormattedStats();

				statsDiv.innerHTML = `
					<div style="font-weight: 600; margin-bottom: 8px; color: #1e293b;">📊 Статистика</div>
					<div id="hh-api-stats-grid">
						<div id="hh-api-stats-item">
							<span id="hh-api-stats-label">Отправлено:</span>
							<span id="hh-api-stats-value">${formattedStats.totalSent}</span>
						</div>
						<div id="hh-api-stats-item">
							<span id="hh-api-stats-label">Обработано:</span>
							<span id="hh-api-stats-value">${formattedStats.totalProcessed}</span>
						</div>
						<div id="hh-api-stats-item">
							<span id="hh-api-stats-label">Пропущено:</span>
							<span id="hh-api-stats-value">${formattedStats.totalSkipped}</span>
						</div>
						<div id="hh-api-stats-item">
							<span id="hh-api-stats-label">Всего отправлено:</span>
							<span id="hh-api-stats-value">${formattedStats.allTimeSent}</span>
						</div>
						<div id="hh-api-stats-item">
							<span id="hh-api-stats-label">Успешность:</span>
							<span id="hh-api-stats-value">${formattedStats.successRate}%</span>
						</div>
						<div id="hh-api-stats-item" style="grid-column: 1 / -1;">
							<span id="hh-api-stats-label">Время работы:</span>
							<span id="hh-api-stats-value">${formattedStats.runningTime}</span>
						</div>
					</div>
				`;
			}
		},

		showNotification: (title, message, type = 'info') => {
			if (!STATE.settings.showNotifications) return;

			const notification = document.createElement('div');
			notification.style.cssText = `
				position: fixed;
				top: 20px;
				right: 20px;
				background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
				color: white;
				padding: 16px 20px;
				border-radius: 12px;
				box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
				z-index: 10002;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 14px;
				max-width: 300px;
				transform: translateX(400px);
				transition: transform 0.3s ease;
			`;

			notification.innerHTML = `
				<div style="font-weight: 600; margin-bottom: 4px;">${title}</div>
				<div style="opacity: 0.9;">${message}</div>
			`;

			document.body.appendChild(notification);

			// Анимация появления
			setTimeout(() => {
				notification.style.transform = 'translateX(0)';
			}, 100);

			// Автоматическое скрытие
			setTimeout(() => {
				notification.style.transform = 'translateX(400px)';
				setTimeout(() => {
					if (document.body.contains(notification)) {
						document.body.removeChild(notification);
					}
				}, 300);
			}, 4000);
		},

		// Новая функция для открытия модалки
		openModal: () => {
			STATE.modalVisible = true;
			const modal = document.getElementById('hh-api-modal');
			if (modal) modal.style.display = 'block';
		},
	};

	// ===== ПРОВЕРКА ВАКАНСИИ =====
	async function checkVacancyStatus(vacancyId) {
		try {
			const res = await fetch(CONFIG.PUBLIC_VACANCY_API + vacancyId);
			if (!res.ok) return { error: true, message: 'Вакансия недоступна' };

			const data = await res.json();

			// Проверяем статус вакансии
			if (data.archived) {
				return { error: true, message: 'Вакансия архивирована' };
			}

			// Проверяем требования к тесту
			if (data.test?.required) {
				return { error: true, message: 'Требуется тест' };
			}

			return { error: false, data };
		} catch (err) {
			console.error('Ошибка проверки вакансии:', err);
			return { error: true, message: 'Ошибка проверки' };
		}
	}

	// ===== ОТПРАВКА ОТКЛИКА =====
	async function respondToVacancy(vacancyId, title, retryCount = 0) {
		try {
			// Проверяем, не отправляли ли уже отклик
			if (Responses.isAlreadyResponded(vacancyId)) {
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: false,
					message: 'Уже отправлен',
				});
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

			const res = await fetch(CONFIG.VACANCY_API_URL, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'x-xsrftoken': xsrf,
					'x-requested-with': 'XMLHttpRequest',
				},
				body: form,
			});

			if (!res.ok) {
				const errorData = await res.json();
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
					return;
				} else if (retryCount < CONFIG.MAX_RETRIES) {
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
						message: 'Ошибка после повторов',
					});
					return;
				}
			} else {
				STATE.responsesCount++;
				Responses.markAsResponded(vacancyId);
				Logger.saveLog({
					id: vacancyId,
					title,
					time: new Date().toISOString(),
					success: true,
				});
			}
		} catch (err) {
			console.error('❌ Ошибка запроса:', err);
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
					message: 'Сетевая ошибка',
				});
			}
		}
	}

	// ===== ОБРАБОТКА СТРАНИЦ =====
	async function processPage(url, pageNum) {
		// Нормализуем URL для универсальности
		let pageUrl = Utils.normalizeUrl(url);

		// Добавляем номер страницы
		pageUrl = pageUrl.includes('?') ? `${pageUrl}&page=${pageNum}` : `${pageUrl}?page=${pageNum}`;
		console.log(`📄 Обрабатываю страницу ${pageNum + 1}: ${pageUrl}`);

		try {
			const res = await fetch(pageUrl, {
				credentials: 'include',
				headers: {
					'User-Agent': navigator.userAgent,
				},
			});

			if (!res.ok) {
				console.error(`Ошибка загрузки страницы ${pageNum + 1}: ${res.status}`);
				return false;
			}

			const text = await res.text();
			const parser = new DOMParser();
			const doc = parser.parseFromString(text, 'text/html');

			// Улучшенный поиск вакансий с несколькими селекторами
			let cards = doc.querySelectorAll('[data-qa="vacancy-serp__vacancy"]');
			if (cards.length === 0) {
				cards = doc.querySelectorAll('.vacancy-serp-item');
			}
			if (cards.length === 0) {
				cards = doc
					.querySelectorAll('[data-qa="serp-item__title"]')
					.map((link) => link.closest('[data-qa*="vacancy"]') || link.parentElement);
			}
			if (cards.length === 0) {
				// Последняя попытка - ищем по структуре
				cards = doc.querySelectorAll('div[data-qa*="vacancy"], article[data-qa*="vacancy"]');
			}

			if (cards.length === 0) {
				console.log('🔚 Вакансии на странице не найдены. Завершаю обработку.');
				return false;
			}

			console.log(`📋 Найдено ${cards.length} вакансий на странице ${pageNum + 1}`);

			for (const card of cards) {
				if (!STATE.isRunning || STATE.responsesCount >= CONFIG.MAX_RESPONSES_PER_DAY) break;

				// Улучшенный поиск ссылки на вакансию
				let link = card.querySelector("a[data-qa='serp-item__title']");
				if (!link) {
					link = card.querySelector("a[href*='/vacancy/']");
				}
				if (!link) {
					link = card.querySelector('h3 a, .vacancy-serp-item__row_header a');
				}

				const title = link?.innerText?.trim();
				const href = link?.href;

				if (!title || !href) continue;

				const vacancyId = href.match(/vacancy\/(\d+)/)?.[1];
				if (!vacancyId) continue;

				STATE.totalProcessed++;
				await respondToVacancy(vacancyId, title);

				// Случайная задержка для имитации человеческого поведения
				await Utils.randomDelay(
					CONFIG.DELAY_BETWEEN_RESPONSES * 0.8,
					CONFIG.DELAY_BETWEEN_RESPONSES * 1.2
				);
			}

			return true;
		} catch (err) {
			console.error(`Ошибка обработки страницы ${pageNum + 1}:`, err);
			return false;
		}
	}

	async function processAllPages(baseUrl) {
		let pageNum = 0;
		let hasMorePages = true;
		let consecutiveErrors = 0;
		const maxConsecutiveErrors = 3;

		while (hasMorePages && STATE.isRunning && STATE.responsesCount < CONFIG.MAX_RESPONSES_PER_DAY) {
			hasMorePages = await processPage(baseUrl, pageNum);

			if (!hasMorePages) {
				consecutiveErrors++;
				if (consecutiveErrors >= maxConsecutiveErrors) {
					console.log('🔚 Слишком много ошибок подряд. Завершаю обработку.');
					break;
				}
			} else {
				consecutiveErrors = 0;
			}

			pageNum++;
			STATE.currentPage = pageNum;

			if (hasMorePages) {
				console.log(`⏳ Перехожу к странице ${pageNum + 1}...`);
				await Utils.delay(CONFIG.DELAY_BETWEEN_PAGES);
			} else {
				console.log('✅ Все страницы обработаны!');
				stopProcess();
			}
		}
	}

	// ===== УПРАВЛЕНИЕ ПРОЦЕССОМ =====
	function stopProcess() {
		STATE.isRunning = false;
		const btn = document.getElementById('hh-api-button');
		if (btn) {
			btn.textContent = '📤 Отправить отклики';
			btn.style.background = 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)';
		}
		Logger.updateStats();

		const stats = Utils.getFormattedStats();
		UI.showNotification(
			'Остановлено',
			`Отправлено ${stats.totalSent} из ${stats.totalProcessed} вакансий`,
			'info'
		);
	}

	function startProcess(url) {
		// Проверяем RESUME_HASH
		if (!CONFIG.RESUME_HASH) {
			alert(
				'❌ ОШИБКА: Не указан RESUME_HASH в конфигурации!\n\nПожалуйста, найдите хеш вашего резюме и укажите его в настройках скрипта.'
			);
			return;
		}

		console.log('✅ Начинаю обработку вакансий...');
		console.log('🔍 URL для обработки:', url);

		STATE.responsesCount = 0;
		STATE.totalProcessed = 0;
		STATE.currentPage = 0;
		STATE.isRunning = true;
		STATE.startTime = Date.now();

		const btn = document.getElementById('hh-api-button');
		if (btn) {
			btn.textContent = '⏸️ Остановить отправку';
			btn.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
		}

		UI.openModal();
		UI.showNotification('Запущено', 'Начинаю отправку откликов', 'success');
		processAllPages(url);
	}

	// ===== СОЗДАНИЕ UI =====
	const UIBuilder = {
		createMainInterface: () => {
			const container = document.querySelector('.supernova-navi-items') || document.body;

			// Создаем основной контейнер
			const uiContainer = document.createElement('div');
			uiContainer.id = 'hh-api-ui-container';
			uiContainer.style.cssText = `
				position: fixed;
				bottom: 20px;
				right: 20px;
				z-index: 9999;
				display: flex;
				flex-direction: column;
				gap: 12px;
				width: 380px;
			`;

			// Создаем поле ввода URL
			const input = UIBuilder.createUrlInput();

			// Создаем кнопку запуска
			const btn = UIBuilder.createMainButton();

			// Создаем кнопки управления
			const controlButtons = UIBuilder.createControlButtons();

			// Добавляем элементы в контейнер
			uiContainer.appendChild(input);
			uiContainer.appendChild(btn);
			uiContainer.appendChild(controlButtons);
			container.appendChild(uiContainer);
		},

		createUrlInput: () => {
			const input = document.createElement('input');
			input.type = 'text';
			input.id = 'hh-api-filter-url';
			input.placeholder = 'Вставьте любой URL с HH.ru';
			input.style.cssText = `
				width: 100%;
				padding: 14px 16px;
				border-radius: 12px;
				border: 2px solid #e2e8f0;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 14px;
				background: #fff;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
				transition: all 0.3s ease;
				outline: none;
				box-sizing: border-box;
			`;

			input.onfocus = () => {
				input.style.borderColor = '#3b82f6';
				input.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
			};

			input.onblur = () => {
				const storedUrl = localStorage.getItem(CONFIG.FILTER_URL_KEY);
				input.style.borderColor = input.value === storedUrl ? '#10b981' : '#e2e8f0';
				input.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.05)';
			};

			const storedUrl = localStorage.getItem(CONFIG.FILTER_URL_KEY);
			if (storedUrl) input.value = storedUrl;

			input.onchange = () => {
				localStorage.setItem(CONFIG.FILTER_URL_KEY, input.value);
				input.style.borderColor = '#10b981';
			};

			return input;
		},

		createMainButton: () => {
			const btn = document.createElement('button');
			btn.id = 'hh-api-button';
			btn.textContent = '📤 Отправить отклики';
			btn.style.cssText = `
				width: 100%;
				padding: 16px;
				background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
				color: #fff;
				border: none;
				border-radius: 12px;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 16px;
				font-weight: 600;
				cursor: pointer;
				transition: all 0.3s ease;
				box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3);
				position: relative;
				overflow: hidden;
			`;

			btn.onmouseover = () => {
				if (!STATE.isRunning) {
					btn.style.transform = 'translateY(-2px)';
					btn.style.boxShadow = '0 6px 20px rgba(59, 130, 246, 0.4)';
				}
			};

			btn.onmouseout = () => {
				btn.style.transform = 'translateY(0)';
				btn.style.boxShadow = '0 4px 16px rgba(59, 130, 246, 0.3)';
			};

			btn.onclick = async () => {
				if (STATE.isRunning) {
					stopProcess();
					return;
				}

				const url = document.getElementById('hh-api-filter-url').value.trim();
				if (!url) {
					UI.showNotification('Ошибка', 'Пожалуйста, введите ссылку с HH.ru', 'error');
					return;
				}

				if (!Utils.validateUrl(url)) {
					UI.showNotification('Ошибка', 'Неверный URL! Введите корректную ссылку с HH.ru', 'error');
					return;
				}

				// ПРИ НАЖАТИИ КНОПКИ ПОВТОРНО ВКЛЮЧАЕМ МОДАЛКУ!
				UI.openModal();
				startProcess(url);
			};

			return btn;
		},

		createControlButtons: () => {
			const container = document.createElement('div');
			container.style.cssText = `
				display: grid;
				grid-template-columns: 1fr 1fr 1fr;
				gap: 8px;
			`;

			// Кнопка экспорта
			const exportBtn = document.createElement('button');
			exportBtn.textContent = '📊 Экспорт';
			exportBtn.style.cssText = `
				padding: 10px;
				background: #6b7280;
				color: #fff;
				border: none;
				border-radius: 8px;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 12px;
				font-weight: 500;
				cursor: pointer;
				transition: all 0.2s ease;
			`;

			exportBtn.onmouseover = () => {
				exportBtn.style.background = '#4b5563';
				exportBtn.style.transform = 'translateY(-1px)';
			};

			exportBtn.onmouseout = () => {
				exportBtn.style.background = '#6b7280';
				exportBtn.style.transform = 'translateY(0)';
			};

			exportBtn.onclick = () => {
				Logger.exportLogs();
				UI.showNotification('Успех', 'Логи экспортированы', 'success');
			};

			// Кнопка очистки
			const clearBtn = document.createElement('button');
			clearBtn.textContent = '🗑️ Очистить';
			clearBtn.style.cssText = `
				padding: 10px;
				background: #ef4444;
				color: #fff;
				border: none;
				border-radius: 8px;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 12px;
				font-weight: 500;
				cursor: pointer;
				transition: all 0.2s ease;
			`;

			clearBtn.onmouseover = () => {
				clearBtn.style.background = '#dc2626';
				clearBtn.style.transform = 'translateY(-1px)';
			};

			clearBtn.onmouseout = () => {
				clearBtn.style.background = '#ef4444';
				clearBtn.style.transform = 'translateY(0)';
			};

			clearBtn.onclick = () => {
				Logger.clearLogs();
			};

			// Кнопка статистики
			const statsBtn = document.createElement('button');
			statsBtn.textContent = '📈 Статистика';
			statsBtn.style.cssText = `
				padding: 10px;
				background: #10b981;
				color: #fff;
				border: none;
				border-radius: 8px;
				font-family: system-ui, -apple-system, sans-serif;
				font-size: 12px;
				font-weight: 500;
				cursor: pointer;
				transition: all 0.2s ease;
			`;

			statsBtn.onmouseover = () => {
				statsBtn.style.background = '#059669';
				statsBtn.style.transform = 'translateY(-1px)';
			};

			statsBtn.onmouseout = () => {
				statsBtn.style.background = '#10b981';
				statsBtn.style.transform = 'translateY(0)';
			};

			statsBtn.onclick = () => {
				const stats = Utils.getFormattedStats();
				const info =
					`📊 СТАТИСТИКА РАБОТЫ\n\n` +
					`📤 Отправлено откликов: ${stats.totalSent}\n` +
					`📋 Обработано вакансий: ${stats.totalProcessed}\n` +
					`📈 Всего отправлено: ${stats.allTimeSent}\n` +
					`✅ Успешность: ${stats.successRate}%\n` +
					`⏱️ Время работы: ${stats.runningTime}\n\n` +
					`🔧 RESUME_HASH: ${CONFIG.RESUME_HASH ? '✅ Указан' : '❌ Не указан'}`;

				console.log(info);
				alert(info);
			};

			container.appendChild(exportBtn);
			container.appendChild(clearBtn);
			container.appendChild(statsBtn);
			return container;
		},
	};

	// ===== ИНИЦИАЛИЗАЦИЯ =====
	function init() {
		console.log('🚀 HH.ru Auto Responder v2.1 загружен');

		// Проверяем конфигурацию
		if (!CONFIG.RESUME_HASH) {
			console.warn('⚠️ ВНИМАНИЕ: RESUME_HASH не указан! Скрипт не будет работать.');
			console.log('💡 Как найти RESUME_HASH:');
			console.log('1. Откройте консоль разработчика (F12)');
			console.log('2. Перейдите на страницу вашего резюме');
			console.log('3. В Network вкладке найдите запрос к API резюме');
			console.log('4. Скопируйте значение resume_hash из запроса');

			// Пытаемся автоматически найти RESUME_HASH
			autoFindResumeHash();
		} else {
			console.log('✅ RESUME_HASH найден:', CONFIG.RESUME_HASH);
		}

		UIBuilder.createMainInterface();

		// Восстанавливаем статистику
		const stats = Utils.getFormattedStats();
		if (stats.allTimeSent > 0) {
			console.log(`📊 Статистика: всего отправлено ${stats.allTimeSent} откликов`);
		}
	}

	// Функция для автоматического поиска RESUME_HASH
	async function autoFindResumeHash() {
		try {
			console.log('🔍 Пытаюсь автоматически найти RESUME_HASH...');

			// Пытаемся получить резюме через API
			const response = await fetch(CONFIG.RESUMES_API, {
				credentials: 'include',
				headers: {
					Accept: 'application/json',
				},
			});

			if (response.ok) {
				const data = await response.json();
				if (data.items && data.items.length > 0) {
					const firstResume = data.items[0];
					if (firstResume.hash) {
						console.log('✅ Автоматически найден RESUME_HASH:', firstResume.hash);
						CONFIG.RESUME_HASH = firstResume.hash;
						UI.showNotification('Успех', 'RESUME_HASH найден автоматически!', 'success');
						return;
					}
				}
			}

			console.log('❌ Не удалось автоматически найти RESUME_HASH');
		} catch (error) {
			console.log('❌ Ошибка при автоматическом поиске RESUME_HASH:', error);
		}
	}

	// Запускаем инициализацию
	init();
})();
