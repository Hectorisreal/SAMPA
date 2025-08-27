// --- FILE: app.js ---

document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let schoolData = {};
    let constraints = {};
    let timetables = {};
    let teacherSchedules = {};
    let allTeachers = [];
    const unassigned = [];
    
    const generatorWorker = new Worker('generator.worker.js');

    const viewModeSelector = document.getElementById('view-mode-selector');
    const classSelector = document.getElementById('class-selector');
    const teacherSelector = document.getElementById('teacher-selector');
    const classContainer = document.getElementById('class-selector-container');
    const teacherContainer = document.getElementById('teacher-selector-container');
    const timetableContainer = document.getElementById('timetable-container');
    const statusMessageContainer = document.getElementById('status-message');
    const regenerateBtn = document.getElementById('regenerate-btn');

    function getClassDivision(className) {
        // Update if your class naming changes, but this matches timetable-generator.js
        const year = parseInt(className[0]);
        if (year <= 3) return "lowerPrimary";
        if (year <= 6) return "upperPrimary";
        return "lowerSecondary";
    }

    function getPeriodType(division, periodId) {
        const divisionSchedule = schoolData.divisionSchedules[division];
        if (periodId === divisionSchedule.breakPeriod) return "break";
        if (periodId === divisionSchedule.lunchPeriod) return "lunch";
        return "lesson";
    }

    const subjectColors = {};
    const colorPalette = [
        '#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#34495e',
        '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#16a085',
        '#27ae60', '#2980b9', '#8e44ad', '#2c3e50', '#f39c12',
        '#d35400', '#c0392b', '#bdc3c7', '#7f8c8d'
    ];
    function getSubjectColor(str) {
        if (typeof str !== 'string' || str.length === 0) return '#bbb';
        if (!subjectColors[str]) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            hash = Math.abs(hash);
            subjectColors[str] = colorPalette[hash % colorPalette.length];
        }
        return subjectColors[str];
    }
    
    function renderClassTimetable(className) {
        if (!timetables[className] || !schoolData.periods) {
            timetableContainer.innerHTML = '<p>No timetable data available for this class.</p>';
            return;
        }
    
        const classTimetable = timetables[className];
        const division = getClassDivision(className);
        const table = document.createElement('table');
        table.className = 'timetable-grid';
    
        // Dynamic period range: include all lesson slots, break and lunch (based on division schedule)
        const divisionSlots = schoolData.divisionSchedules[division].lessonSlots;
        const breakAndLunch = [schoolData.divisionSchedules[division].breakPeriod, schoolData.divisionSchedules[division].lunchPeriod];
        const allDayPeriods = [...divisionSlots, ...breakAndLunch];
        const lastPeriodId = Math.max(...allDayPeriods);
        const displayPeriods = schoolData.periods.filter(p => p.type !== 'arrival' && p.id <= lastPeriodId);
        
        const thead = table.createTHead();
        const headerRow = thead.insertRow();
        headerRow.insertCell().textContent = 'Day';
        displayPeriods.forEach(period => {
            const th = document.createElement('th');
            th.className = 'time-header';
            th.textContent = period.time;
            headerRow.appendChild(th);
        });
    
        const tbody = table.createTBody();
        schoolData.days.forEach(day => {
            const row = tbody.insertRow();
            row.insertCell().textContent = day;
    
            displayPeriods.forEach(period => {
                const cell = row.insertCell();
                const lessonData = classTimetable[day]?.[period.id];
                
                // Find special event for this period, division, and day
                const specialEvent = schoolData.specialEvents.find(event => 
                    event.day === day &&
                    (
                        (event.periodId === period.id) ||
                        (event.periodIds && event.periodIds.includes(period.id))
                    ) &&
                    (
                        event.appliesTo === 'all' ||
                        (Array.isArray(event.appliesTo) && event.appliesTo.includes(division))
                    )
                );
    
                const periodType = getPeriodType(division, period.id);

                // ---- SAFELY HANDLE ALL TYPES OF CELLS ----
                if (specialEvent) {
                    const eventDiv = document.createElement('div');
                    eventDiv.className = 'lesson special-event';
                    eventDiv.style.backgroundColor = specialEvent.color || "#bbb";
                    eventDiv.innerHTML = `<span class="subject">${specialEvent.name}</span>`;
                    cell.appendChild(eventDiv);
                } else if (lessonData && lessonData.type === "event") {
                    const eventDiv = document.createElement('div');
                    eventDiv.className = 'lesson special-event';
                    eventDiv.style.backgroundColor = lessonData.color || "#bbb";
                    eventDiv.innerHTML = `<span class="subject">${lessonData.name || "Event"}</span>`;
                    cell.appendChild(eventDiv);
                } else if (periodType === "break" || (lessonData && lessonData.type === "break")) {
                    const breakDiv = document.createElement('div');
                    breakDiv.className = 'lesson special-event';
                    breakDiv.style.backgroundColor = '#3498db';
                    breakDiv.innerHTML = `<span class="subject">Break</span>`;
                    cell.appendChild(breakDiv);
                } else if (periodType === "lunch" || (lessonData && lessonData.type === "lunch")) {
                    const lunchDiv = document.createElement('div');
                    lunchDiv.className = 'lesson special-event';
                    lunchDiv.style.backgroundColor = '#e67e22';
                    lunchDiv.innerHTML = `<span class="subject">Lunch</span>`;
                    cell.appendChild(lunchDiv);
                } else if (lessonData && typeof lessonData.subject === "string" && lessonData.subject.length > 0) {
                    // Normal lesson
                    const lessonDiv = document.createElement('div');
                    lessonDiv.className = 'lesson';
                    lessonDiv.style.backgroundColor = getSubjectColor(lessonData.subject);
                    lessonDiv.innerHTML = `<span class="subject">${lessonData.subject}</span><span class="teacher">${lessonData.teacher || ""}</span>`;
                    cell.appendChild(lessonDiv);
                } else if (lessonData && lessonData.type === "free") {
                    const freeDiv = document.createElement('div');
                    freeDiv.className = 'lesson free-period';
                    freeDiv.style.backgroundColor = "#eee";
                    freeDiv.innerHTML = `<span class="subject">Free</span>`;
                    cell.appendChild(freeDiv);
                } else if (lessonData && lessonData.type === "arrival") {
                    const arrivalDiv = document.createElement('div');
                    arrivalDiv.className = 'lesson arrival-period';
                    arrivalDiv.style.backgroundColor = "#ddd";
                    arrivalDiv.innerHTML = `<span class="subject">Arrival</span>`;
                    cell.appendChild(arrivalDiv);
                } else {
                    // Unknown or empty slot
                    cell.innerHTML = "";
                }
            });
        });
        timetableContainer.innerHTML = '';
        timetableContainer.appendChild(table);
    }

    function renderTeacherTimetable(teacherName) {
        if (!teacherSchedules[teacherName] || !schoolData.periods) {
            timetableContainer.innerHTML = '<p>No timetable data available for this teacher.</p>';
            return;
        }
    
        const teacherData = teacherSchedules[teacherName];
        const table = document.createElement('table');
        table.className = 'timetable-grid';
    
        // Show all possible periods for a teacher's view to see their full day (excluding arrival)
        const displayPeriods = schoolData.periods.filter(p => p.type !== 'arrival');
        const thead = table.createTHead();
        const headerRow = thead.insertRow();
        headerRow.insertCell().textContent = 'Day';
        displayPeriods.forEach(period => {
            const th = document.createElement('th');
            th.className = 'time-header';
            th.textContent = period.time;
            headerRow.appendChild(th);
        });
    
        const tbody = table.createTBody();
        schoolData.days.forEach(day => {
            const row = tbody.insertRow();
            row.insertCell().textContent = day;
    
            displayPeriods.forEach(period => {
                const cell = row.insertCell();
                const lessonData = teacherData[day]?.[period.id];
    
                // Only show special event if it applies to "all" (since we don't know division here)
                const specialEvent = schoolData.specialEvents.find(event =>
                    event.day === day &&
                    (
                        (event.periodId === period.id) ||
                        (event.periodIds && event.periodIds.includes(period.id))
                    ) &&
                    (event.appliesTo === 'all')
                );

                // SAFELY HANDLE ALL TYPES OF CELLS
                if (lessonData && typeof lessonData.subject === "string" && lessonData.subject.length > 0) {
                    const lessonDiv = document.createElement('div');
                    lessonDiv.className = 'lesson';
                    lessonDiv.style.backgroundColor = getSubjectColor(lessonData.subject);
                    lessonDiv.innerHTML = `<span class="subject">${lessonData.subject}</span><span class="class-name">Class ${lessonData.className}</span>`;
                    cell.appendChild(lessonDiv);
                } else if (lessonData && lessonData.type === "free") {
                    const freeDiv = document.createElement('div');
                    freeDiv.className = 'lesson free-period';
                    freeDiv.style.backgroundColor = "#eee";
                    freeDiv.innerHTML = `<span class="subject">Free</span>`;
                    cell.appendChild(freeDiv);
                } else if (lessonData && lessonData.type === "arrival") {
                    const arrivalDiv = document.createElement('div');
                    arrivalDiv.className = 'lesson arrival-period';
                    arrivalDiv.style.backgroundColor = "#ddd";
                    arrivalDiv.innerHTML = `<span class="subject">Arrival</span>`;
                    cell.appendChild(arrivalDiv);
                } else if (specialEvent) {
                    const eventDiv = document.createElement('div');
                    eventDiv.className = 'lesson special-event';
                    eventDiv.style.backgroundColor = specialEvent.color || "#bbb";
                    eventDiv.innerHTML = `<span class="subject">${specialEvent.name}</span>`;
                    cell.appendChild(eventDiv);
                } else {
                    // Unknown or empty slot
                    cell.innerHTML = "";
                }
            });
        });
    
        timetableContainer.innerHTML = '';
        timetableContainer.appendChild(table);
    }
    
    function processResults() {
        teacherSchedules = {};
        for (const className in timetables) {
            for (const day in timetables[className]) {
                for (const periodId in timetables[className][day]) {
                    const lesson = timetables[className][day][periodId];
                    const teacher = lesson.teacher;
                    if (!teacherSchedules[teacher]) teacherSchedules[teacher] = {};
                    if (!teacherSchedules[teacher][day]) teacherSchedules[teacher][day] = {};
                    teacherSchedules[teacher][day][periodId] = { subject: lesson.subject, className: className };
                }
            }
        }
    }
    
    function updateStatusMessage() {
        if (unassigned.length > 0) {
            statusMessageContainer.className = 'status-warning';
            let message = `<strong>Generation Complete with Warnings:</strong> Some lessons could not be scheduled.<ul>`;
            // Group by class/subject, show reason and count
            const grouped = unassigned.reduce((acc, item) => {
                const key = `${item.className || item.classGroup} - ${item.subject}`;
                if (!acc[key]) acc[key] = { count: 0, reason: item.reason };
                acc[key].count += (item.periodsRemaining || 1);
                return acc;
            }, {});
            for (const [key, { count, reason }] of Object.entries(grouped)) {
                message += `<li><strong>${key}:</strong> ${reason} (${count > 1 ? `${count} times` : 'once'})</li>`;
            }
            message += `</ul>`;
            statusMessageContainer.innerHTML = message;
        } else {
            statusMessageContainer.className = 'status-success';
            statusMessageContainer.innerHTML = '<strong>Success!</strong> All lessons were scheduled successfully.';
        }
    }

    function generateTimetable() {
        console.log("App: Asking worker to generate timetable...");
        statusMessageContainer.className = 'status-info';
        statusMessageContainer.innerHTML = '<strong>Generating timetable...</strong> This may take a moment. The UI will remain responsive.';
        regenerateBtn.disabled = true;
        regenerateBtn.textContent = 'Generating...';
        generatorWorker.postMessage({ schoolData, constraints });
    }

    function populateSelectors() {
        // Clear previous options to avoid duplicates!
        classSelector.innerHTML = '';
        teacherSelector.innerHTML = '';

        const allClasses = Object.keys(schoolData.teachers).sort();
        allClasses.forEach(className => {
            const option = document.createElement('option');
            option.value = className;
            option.textContent = `Class ${className}`;
            classSelector.appendChild(option);
        });

        // Teachers are now unique, possibly with part-time tag from constraints
        const teacherSet = new Set(Object.values(schoolData.teachers).flatMap(obj => Object.values(obj)));
        allTeachers = Array.from(teacherSet).sort();
        allTeachers.forEach(teacherName => {
            const option = document.createElement('option');
            option.value = teacherName;
            option.textContent = constraints.partTimeTeachers && constraints.partTimeTeachers.includes(teacherName)
                ? `${teacherName} (Part-time)` : teacherName;
            teacherSelector.appendChild(option);
        });
    }

    function refreshCurrentView() {
        if (viewModeSelector.value === 'class') {
            renderClassTimetable(classSelector.value);
        } else {
            renderTeacherTimetable(teacherSelector.value);
        }
    }

    async function init() {
        try {
            statusMessageContainer.innerHTML = 'Loading school data...';
            const response = await fetch('data.json');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            schoolData = data.schoolData;
            constraints = data.constraints;
            console.log("School data loaded successfully.");

            populateSelectors();
            
            viewModeSelector.addEventListener('change', (e) => {
                const isClassView = e.target.value === 'class';
                classContainer.style.display = isClassView ? 'flex' : 'none';
                teacherContainer.style.display = isClassView ? 'none' : 'flex';
                refreshCurrentView();
            });
            classSelector.addEventListener('change', () => renderClassTimetable(classSelector.value));
            teacherSelector.addEventListener('change', () => renderTeacherTimetable(teacherSelector.value));
            regenerateBtn.addEventListener('click', generateTimetable);
            
            generatorWorker.onmessage = (event) => {
                const { type, timetables: result, unassigned: unassignedResult } = event.data;
                if (type === 'result') {
                    console.log("App: Received results from worker.");
                    timetables = result;
                    unassigned.length = 0;
                    unassigned.push(...unassignedResult);
                    processResults();
                    updateStatusMessage();
                    refreshCurrentView();
                    regenerateBtn.disabled = false;
                    regenerateBtn.textContent = 'Regenerate Timetable';
                }
            };

            generatorWorker.onerror = (error) => {
                console.error("Error in generator worker:", error);
                statusMessageContainer.className = 'status-error';
                statusMessageContainer.innerHTML = 'An error occurred during generation. Check the console for details.';
                regenerateBtn.disabled = false;
                regenerateBtn.textContent = 'Regenerate Timetable';
            };

            generateTimetable();
            
        } catch (error) {
            console.error("Initialization failed:", error);
            statusMessageContainer.className = 'status-error';
            statusMessageContainer.innerHTML = `<strong>Failed to initialize application.</strong> Could not load or parse <code>data.json</code>. Please check the file and the browser's console for errors.`;
        }
    }

    init();
});
