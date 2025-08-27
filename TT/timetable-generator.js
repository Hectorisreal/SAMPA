class TimetableGenerator {
    constructor(schoolData, constraints) {
        this.schoolData = schoolData;
        this.constraints = constraints;
        this.timetables = {};
        this.globalSchedule = {};
        this.unassignedLessons = [];
        this.teacherStats = {};
    }

    generate() {
        console.log("Generator: Starting timetable generation process...");
        this._initialize();
        this._scheduleRestrictedSubjects();
        this._schedulePESynchronization();
        this._scheduleICTLessons();
        this._scheduleStrictDoubles();
        this._scheduleRemainingLessons();
        console.log(`Generator: Process complete. ${this.unassignedLessons.length} unassigned lesson groups.`);
        this._printTeacherStats();
        return this.timetables;
    }

    _initialize() {
        this.unassignedLessons = [];
        this.teacherStats = {};
        const allClasses = Object.keys(this.schoolData.teachers);

        allClasses.forEach(className => {
            this.timetables[className] = {};
            this.schoolData.days.forEach(day => {
                this.timetables[className][day] = {};
            });
        });

        this.schoolData.days.forEach(day => {
            this.globalSchedule[day] = {};
            this.schoolData.periods.forEach(period => {
                this.globalSchedule[day][period.id] = {
                    teachers: new Set(),
                    resources: { ICT: null }
                };
            });
        });

        const teacherSet = new Set(Object.values(this.schoolData.teachers).flatMap(Object.values));
        teacherSet.forEach(teacher => {
            this.teacherStats[teacher] = { totalPeriods: 0, dailyPeriods: {} };
            this.schoolData.days.forEach(day => this.teacherStats[teacher].dailyPeriods[day] = 0);
        });

        allClasses.forEach(className => {
            const division = this._getClassDivision(className);
            const subjects = this.schoolData.subjects[division];
            if (!subjects) return;
            Object.entries(subjects).forEach(([subject, periods]) => {
                const teacher = this.schoolData.teachers[className]?.[subject];
                if (teacher && this.teacherStats[teacher]) {
                    this.teacherStats[teacher].totalPeriods += periods;
                }
            });
        });
    }

    _getClassDivision(className) {
        const year = parseInt(className[0]);
        if (year <= 3) return "lowerPrimary";
        if (year <= 6) return "upperPrimary";
        return "lowerSecondary";
    }

    _getAvailableLessonSlots(className, day) {
        const division = this._getClassDivision(className);
        let slots = [...this.schoolData.divisionSchedules[division].lessonSlots];

        const eventsOnDay = this.schoolData.specialEvents.filter(e => e.day === day && (e.appliesTo === 'all' || e.appliesTo.includes(division)));
        if (eventsOnDay.length > 0) {
            const eventPeriods = eventsOnDay.flatMap(e => e.periodIds || [e.periodId]);
            slots = slots.filter(s => !eventPeriods.includes(s));
        }

        return slots;
    }

    _countSubjectOnDay(className, subject, day) {
        return Object.values(this.timetables[className][day]).filter(l => l.subject === subject).length;
    }

    _getScheduledPeriods(className, subject) {
        return this.schoolData.days.reduce((acc, day) => acc + this._countSubjectOnDay(className, subject, day), 0);
    }

    canAssignLesson(className, subject, teacher, day, slot) {
        const { workloadLimits, teacherAvailability, subjectRestrictions, singleResourceSubjects } = this.constraints;
        if (!this.teacherStats[teacher]) return { valid: false, reason: "Teacher not found in stats" };

        if (
            this.teacherStats[teacher].dailyPeriods[day] >= (
                this.constraints.teacherWorkloadExceptions.includes(teacher)
                    ? workloadLimits.maxTeacherPeriodsPerDayException
                    : workloadLimits.maxTeacherPeriodsPerDay
            )
        ) {
            return { valid: false, reason: `Teacher workload exceeded` };
        }

        if (this._countSubjectOnDay(className, subject, day) >= workloadLimits.maxClassPeriodsPerDay) return { valid: false, reason: `Subject max daily load` };

        const availabilityRule = teacherAvailability[teacher];
        if (availabilityRule) {
            if (availabilityRule.availableDays && !availabilityRule.availableDays.includes(day)) return { valid: false, reason: `Teacher only available on ${availabilityRule.availableDays.join()}` };
            if (availabilityRule.unavailableDays && availabilityRule.unavailableDays.includes(day)) return { valid: false, reason: `Teacher unavailable on ${day}` };
        }

        const subjectRule = subjectRestrictions[subject];
        if (subjectRule && subjectRule.days && !subjectRule.days.includes(day)) return { valid: false, reason: `Subject restricted to ${subjectRule.days.join()}` };

        if (this.globalSchedule[day][slot].teachers.has(teacher)) return { valid: false, reason: `Teacher booked` };
        if (this.timetables[className][day][slot]) return { valid: false, reason: `Class booked` };

        if (singleResourceSubjects.includes(subject)) {
            if (this.globalSchedule[day][slot].resources[subject]) {
                return { valid: false, reason: `${subject} resource booked` };
            }
        }

        return { valid: true };
    }

    assignLesson(className, subject, teacher, day, slot) {
        this.timetables[className][day][slot] = { subject, teacher };
        this.globalSchedule[day][slot].teachers.add(teacher);
        if (this.constraints.singleResourceSubjects.includes(subject)) {
            this.globalSchedule[day][slot].resources[subject] = className;
        }
        this.teacherStats[teacher].dailyPeriods[day]++;
    }

    _scheduleLesson(lesson, allowedDays) {
        let { periods: periodsToSchedule, className, subject } = lesson;
        const division = this._getClassDivision(className);
        const rule = this.constraints.doublePeriodSubjects.find(r => r.subject === subject && r.divisions.includes(division));

        if (rule?.strict === "mixed" && rule.structure) {
            // Schedule exactly as per mixed structure (e.g. 3 double, 2 single)
            for (let i = 0; i < (rule.structure.doubles || 0); i++) {
                if (this._scheduleSpecificPeriods(lesson, allowedDays, 2)) {
                    periodsToSchedule -= 2;
                } else {
                    // If can't find double, try to fill as singles for this double
                    let singlesScheduled = 0;
                    for (let s = 0; s < 2; s++) {
                        if (this._scheduleSpecificPeriods(lesson, allowedDays, 1)) {
                            periodsToSchedule -= 1;
                            singlesScheduled++;
                        }
                    }
                    if (singlesScheduled < 2) {
                        this.unassignedLessons.push({ className, subject, reason: "Could not find slot for double period (mixed rule)" });
                    }
                }
            }
            for (let i = 0; i < (rule.structure.singles || 0); i++) {
                if (this._scheduleSpecificPeriods(lesson, allowedDays, 1)) {
                    periodsToSchedule -= 1;
                } else {
                    this.unassignedLessons.push({ className, subject, reason: "Could not find slot for single period (mixed rule)" });
                }
            }
            // If periodsToSchedule > 0 (recipe doesn't sum to total needed), fill singles as fallback
            while (periodsToSchedule > 0) {
                if (this._scheduleSpecificPeriods(lesson, allowedDays, 1)) {
                    periodsToSchedule -= 1;
                } else {
                    this.unassignedLessons.push({ className, subject, reason: "Could not find slot (mixed rule overflow)" });
                    break;
                }
            }
        } else if (rule?.strict === true) {
            // Only doubles are allowed (Music, Art, ICT)
            let doubles = Math.floor(periodsToSchedule / 2);
            for (let i = 0; i < doubles; i++) {
                if (this._scheduleSpecificPeriods(lesson, allowedDays, 2)) {
                    periodsToSchedule -= 2;
                } else {
                    // Try as two singles if no double found, but for strict:true, most likely you want only doubles
                    let singlesScheduled = 0;
                    for (let s = 0; s < 2; s++) {
                        if (this._scheduleSpecificPeriods(lesson, allowedDays, 1)) {
                            periodsToSchedule -= 1;
                            singlesScheduled++;
                        }
                    }
                    if (singlesScheduled < 2) {
                        this.unassignedLessons.push({ className, subject, reason: "Could not find slot for double period or singles" });
                    }
                }
            }
        } else {
            // For everything else (not in doublePeriodSubjects), schedule all as singles
            while (periodsToSchedule > 0) {
                if (this._scheduleSpecificPeriods(lesson, allowedDays, 1)) {
                    periodsToSchedule -= 1;
                } else {
                    this.unassignedLessons.push({ className, subject, reason: "Could not find slot (flexible/single)" });
                    break;
                }
            }
        }
    }

    _scheduleSpecificPeriods({ className, subject, teacher }, allowedDays, numPeriods) {
        const shuffledDays = [...allowedDays].sort(() => Math.random() - 0.5);

        for (const day of shuffledDays) {
            const slots = this._getAvailableLessonSlots(className, day);
            if (slots.length < numPeriods) continue;

            // Priority 1: Find consecutive empty slots (back-to-back)
            if (numPeriods === 2) {
                for (let i = 0; i < slots.length - 1; i++) {
                    if (slots[i+1] === slots[i] + 1) {
                        const [s1, s2] = [slots[i], slots[i+1]];
                        if (
                            this.canAssignLesson(className, subject, teacher, day, s1).valid &&
                            this.canAssignLesson(className, subject, teacher, day, s2).valid
                        ) {
                            this.assignLesson(className, subject, teacher, day, s1);
                            this.assignLesson(className, subject, teacher, day, s2);
                            return true;
                        }
                    }
                }
                // Priority 2: Find pair split by break or lunch
                const division = this._getClassDivision(className);
                const { breakPeriod, lunchPeriod } = this.schoolData.divisionSchedules[division];
                for (let i = 0; i < slots.length - 1; i++) {
                    for (let j = i + 1; j < slots.length; j++) {
                        const s1 = slots[i];
                        const s2 = slots[j];
                        if (s2 - s1 === 2) {
                            const middlePeriod = s1 + 1;
                            if (middlePeriod === breakPeriod || middlePeriod === lunchPeriod) {
                                if (
                                    this.canAssignLesson(className, subject, teacher, day, s1).valid &&
                                    this.canAssignLesson(className, subject, teacher, day, s2).valid
                                ) {
                                    this.assignLesson(className, subject, teacher, day, s1);
                                    this.assignLesson(className, subject, teacher, day, s2);
                                    return true;
                                }
                            }
                        }
                    }
                }
            } else if (numPeriods === 1) {
                for (const slot of slots.sort(() => Math.random() - 0.5)) {
                    if (this.canAssignLesson(className, subject, teacher, day, slot).valid) {
                        this.assignLesson(className, subject, teacher, day, slot);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    _scheduleSyncedPeriods(group, subject, numPeriods) {
        const teacher = this.schoolData.teachers[group[0]][subject];
        const allowedDays = this.schoolData.days.filter(d => {
            const availability = this.constraints.teacherAvailability[teacher];
            if (availability?.availableDays) return availability.availableDays.includes(d);
            if (availability?.unavailableDays) return !availability.unavailableDays.includes(d);
            return true;
        });

        for (const day of allowedDays.sort(() => Math.random() - 0.5)) {
            const slots = this._getAvailableLessonSlots(group[0], day);
            if (slots.length < numPeriods) continue;

            for (let i = 0; i <= slots.length - numPeriods; i++) {
                const slotsToTry = slots.slice(i, i + numPeriods);
                if (slotsToTry.length > 1 && slotsToTry[slotsToTry.length - 1] - slotsToTry[0] !== numPeriods - 1) continue;

                const canAssignAll = group.every(c => slotsToTry.every(s => this.canAssignLesson(c, subject, teacher, day, s).valid));
                if (canAssignAll) {
                    group.forEach(c => slotsToTry.forEach(s => this.assignLesson(c, subject, teacher, day, s)));
                    return true;
                }
            }
        }
        return false;
    }

    // --- SCHEDULING ORDER ---
    _scheduleRestrictedSubjects() {
        console.log("Generator Step 1: Scheduling strictly restricted subjects...");
        Object.entries(this.constraints.subjectRestrictions).forEach(([subject, rule]) => {
            this._scheduleAllForSubject(subject, rule.days);
        });
    }

    _schedulePESynchronization() {
        console.log("Generator Step 2: Scheduling synchronized P.E. lessons...");
        this.constraints.peSynchronization.forEach(group => {
            const subject = "P.E.";
            const needed = this.schoolData.subjects[this._getClassDivision(group[0])][subject];
            if (!needed) return;

            let scheduled = this._getScheduledPeriods(group[0], subject);
            while (scheduled < needed) {
                const periodsToSchedule = (needed - scheduled >= 2) ? 2 : 1;
                if (this._scheduleSyncedPeriods(group, subject, periodsToSchedule)) {
                    scheduled += periodsToSchedule;
                } else {
                    this.unassignedLessons.push({ className: group.join(','), subject, reason: "Could not find sync P.E. slot" });
                    break;
                }
            }
        });
    }

    _scheduleICTLessons() {
        console.log("Generator Step 3: Scheduling ICT lessons (single resource)...");
        this._scheduleAllForSubject("ICT");
    }

    _scheduleStrictDoubles() {
        console.log("Generator Step 4: Scheduling remaining strict double periods...");
        this.constraints.doublePeriodSubjects.filter(r => r.strict).forEach(rule => this._scheduleAllForSubject(rule.subject));
    }

    _scheduleRemainingLessons() {
        console.log("Generator Step 5: Scheduling all remaining lessons...");
        const allSubjects = [...new Set(Object.values(this.schoolData.subjects).flatMap(div => Object.keys(div)))];
        allSubjects.sort(() => Math.random() - 0.5).forEach(subject => this._scheduleAllForSubject(subject));
    }

    _scheduleAllForSubject(subject, allowedDays = this.schoolData.days) {
        Object.keys(this.schoolData.teachers).forEach(className => {
            const division = this._getClassDivision(className);
            const teacher = this.schoolData.teachers[className]?.[subject];
            const needed = this.schoolData.subjects[division]?.[subject];
            if (teacher && needed) {
                const scheduled = this._getScheduledPeriods(className, subject);
                if (scheduled < needed) {
                    this._scheduleLesson({
                        className, subject, teacher,
                        periods: needed - scheduled
                    }, allowedDays);
                }
            }
        });
    }

    _printTeacherStats() {
        console.log("\n--- Teacher Workload Summary ---");
        const sorted = Object.entries(this.teacherStats)
            .sort((a, b) => (b[1].totalPeriods || 0) - (a[1].totalPeriods || 0));

        sorted.forEach(([teacher, stats]) => {
            const dailyLoads = Object.entries(stats.dailyPeriods).map(([day, p]) => `${day.substr(0,1)}:${p}`).join(" ");
            console.log(`  ${teacher.padEnd(25)}: ${stats.totalPeriods} total | ${dailyLoads}`);
        });
        console.log("---------------------------------");
    }
}
