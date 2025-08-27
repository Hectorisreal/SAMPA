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
    this._initialize();
    this._scheduleSpecialEvents();
    this._scheduleRestrictedSubjects();
    this._scheduleSingleResourceSubjects();
    this._scheduleStrictDoublePeriodSubjects();
    this._schedulePE();
    this._scheduleRemainingLessons();
    this._injectBreakAndLunch();
    this._fillEmptySlots();
    this._validateTimetable();
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
    const teacherSet = new Set(Object.values(this.schoolData.teachers).flatMap(Object.values).flatMap(t => Array.isArray(t) ? t : [t]));
    teacherSet.forEach(teacher => {
      this.teacherStats[teacher] = { totalPeriods: 0, dailyPeriods: {} };
      this.schoolData.days.forEach(day => this.teacherStats[teacher].dailyPeriods[day] = 0);
    });
    allClasses.forEach(className => {
      const division = this._getClassDivision(className);
      const subjects = this.schoolData.subjects[division];
      if (!subjects) return;
      Object.entries(subjects).forEach(([subject, periods]) => {
        const teacher = this._getTeacherForClassSubject(className, subject);
        if (teacher && this.teacherStats[teacher]) {
          this.teacherStats[teacher].totalPeriods += periods;
        }
      });
    });
  }

  _getClassDivision(className) {
    let match = className.match(/^Year\s*(\d+)/i);
    if (!match) match = className.match(/^(\d+)[A-Z]?$/i);
    const year = match ? parseInt(match[1], 10) : NaN;
    if (isNaN(year)) return "unknown";
    if (year >= 1 && year <= 3) return "lowerPrimary";
    if (year >= 4 && year <= 6) return "upperPrimary";
    if (year >= 7 && year <= 9) return "lowerSecondary";
    if (year >= 10 && year <= 11) return "upperSecondary";
    return "unknown";
  }

  _getLessonSlotsForClass(className) {
    if (
      this.schoolData.perClassSchedules &&
      this.schoolData.perClassSchedules[className] &&
      Array.isArray(this.schoolData.perClassSchedules[className].lessonSlots)
    ) {
      return [...this.schoolData.perClassSchedules[className].lessonSlots];
    }
    const division = this._getClassDivision(className);
    if (
      this.schoolData.divisionSchedules &&
      this.schoolData.divisionSchedules[division] &&
      Array.isArray(this.schoolData.divisionSchedules[division].lessonSlots)
    ) {
      return [...this.schoolData.divisionSchedules[division].lessonSlots];
    }
    return [];
  }

  _getAvailableLessonSlots(className, day) {
    return this._getLessonSlotsForClass(className);
  }

  _getBreakPeriod(className) {
    if (
      this.schoolData.perClassSchedules &&
      this.schoolData.perClassSchedules[className] &&
      this.schoolData.perClassSchedules[className].breakPeriod !== undefined
    ) {
      return this.schoolData.perClassSchedules[className].breakPeriod;
    }
    const division = this._getClassDivision(className);
    if (
      this.schoolData.divisionSchedules &&
      this.schoolData.divisionSchedules[division] &&
      this.schoolData.divisionSchedules[division].breakPeriod !== undefined
    ) {
      return this.schoolData.divisionSchedules[division].breakPeriod;
    }
    return undefined;
  }

  _getLunchPeriod(className) {
    if (
      this.schoolData.perClassSchedules &&
      this.schoolData.perClassSchedules[className] &&
      this.schoolData.perClassSchedules[className].lunchPeriod !== undefined
    ) {
      return this.schoolData.perClassSchedules[className].lunchPeriod;
    }
    const division = this._getClassDivision(className);
    if (
      this.schoolData.divisionSchedules &&
      this.schoolData.divisionSchedules[division] &&
      this.schoolData.divisionSchedules[division].lunchPeriod !== undefined
    ) {
      return this.schoolData.divisionSchedules[division].lunchPeriod;
    }
    return undefined;
  }

  _getTeacherForClassSubject(className, subject) {
    let teacher = this.schoolData.teachers[className]?.[subject];
    return Array.isArray(teacher) ? teacher[0] : teacher;
  }

  _countSubjectOnDay(className, subject, day) {
    return Object.values(this.timetables[className][day]).filter(item => item.subject === subject).length;
  }

  _getScheduledPeriods(className, subject) {
    return this.schoolData.days.reduce((acc, day) => acc + this._countSubjectOnDay(className, subject, day), 0);
  }

  canAssignLesson(className, subject, teacher, day, slot) {
    const { workloadLimits, teacherAvailability, subjectRestrictions } = this.constraints;
    const division = this._getClassDivision(className);
    const lessonSlots = this._getAvailableLessonSlots(className, day);
    if (!lessonSlots.includes(slot)) {
      return { valid: false, reason: `Slot ${slot} is not a valid lesson slot for ${className}` };
    }
    if (this.timetables[className][day][slot] && this.timetables[className][day][slot].type === undefined) {
      return { valid: false, reason: `Class slot ${slot} already booked by ${this.timetables[className][day][slot].subject}` };
    }
    if (this.teacherStats[teacher]) {
      const maxPeriods = this.constraints.teacherWorkloadExceptions.includes(teacher)
        ? workloadLimits.maxTeacherPeriodsPerDayException
        : workloadLimits.maxTeacherPeriodsPerDay;
      if (this.teacherStats[teacher].dailyPeriods[day] >= maxPeriods) {
        return { valid: false, reason: `Teacher ${teacher} daily workload exceeded on ${day}` };
      }
      if (this.globalSchedule[day][slot].teachers.has(teacher)) {
        return { valid: false, reason: `Teacher ${teacher} already booked globally at ${day} P${slot}` };
      }
    }
    const availabilityRule = teacherAvailability[teacher];
    if (availabilityRule) {
      if (availabilityRule.availableDays && !availabilityRule.availableDays.includes(day)) {
        return { valid: false, reason: `Teacher ${teacher} not available on ${day}` };
      }
      if (availabilityRule.unavailableDays && availabilityRule.unavailableDays.includes(day)) {
        return { valid: false, reason: `Teacher ${teacher} specifically unavailable on ${day}` };
      }
    }
    const subjectRule = subjectRestrictions[subject];
    if (subjectRule && subjectRule.days && !subjectRule.days.includes(day)) {
      return { valid: false, reason: `Subject ${subject} restricted to specific days, and ${day} is not one of them.` };
    }
    if (subject === "ICT" && this.globalSchedule[day][slot].resources["ICT"]) {
      return { valid: false, reason: `ICT lab booked by ${this.globalSchedule[day][slot].resources["ICT"]} at ${day} P${slot}` };
    }
    return { valid: true };
  }

  assignLesson(className, subject, teacher, day, slot) {
    this.timetables[className][day][slot] = { subject, teacher };
    if (teacher) {
      this.globalSchedule[day][slot].teachers.add(teacher);
      if (this.teacherStats[teacher]) {
        this.teacherStats[teacher].dailyPeriods[day]++;
      }
    }
    if (subject === "ICT") {
      this.globalSchedule[day][slot].resources["ICT"] = className;
    }
  }

  _scheduleLessonBlock({ className, subject, teacher }, allowedDays, numPeriods) {
    const shuffledDays = [...allowedDays].sort(() => Math.random() - 0.5);
    const lessonSlots = this._getAvailableLessonSlots(className, shuffledDays[0]);
    for (const day of shuffledDays) {
      const availableSlotsOnDay = lessonSlots.filter(slot =>
        !this.timetables[className][day][slot] &&
        !this.schoolData.specialEvents.some(e => e.day === day && (e.periodId === slot || (Array.isArray(e.periodIds) && e.periodIds.includes(slot))))
      ).sort(() => Math.random() - 0.5);
      if (availableSlotsOnDay.length < numPeriods) continue;
      if (numPeriods === 1) {
        for (const slot of availableSlotsOnDay) {
          const check = this.canAssignLesson(className, subject, teacher, day, slot);
          if (check.valid) {
            this.assignLesson(className, subject, teacher, day, slot);
            return true;
          }
        }
      } else if (numPeriods === 2) {
        for (let i = 0; i < availableSlotsOnDay.length - 1; i++) {
          const s1 = availableSlotsOnDay[i];
          const s2 = availableSlotsOnDay[i + 1];
          if (s2 === s1 + 1) {
            const check1 = this.canAssignLesson(className, subject, teacher, day, s1);
            const check2 = this.canAssignLesson(className, subject, teacher, day, s2);
            if (check1.valid && check2.valid) {
              this.assignLesson(className, subject, teacher, day, s1);
              this.assignLesson(className, subject, teacher, day, s2);
              return true;
            }
          }
        }
        for (let i = 0; i < availableSlotsOnDay.length; i++) {
          for (let j = i + 1; j < availableSlotsOnDay.length; j++) {
            const s1 = availableSlotsOnDay[i];
            const s2 = availableSlotsOnDay[j];
            const check1 = this.canAssignLesson(className, subject, teacher, day, s1);
            const check2 = this.canAssignLesson(className, subject, teacher, day, s2);
            if (check1.valid && check2.valid) {
              this.assignLesson(className, subject, teacher, day, s1);
              this.assignLesson(className, subject, teacher, day, s2);
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  _scheduleAllForSubject(subject, allowedDays = this.schoolData.days, scheduleAsDoubleOnly = false) {
    const allClasses = Object.keys(this.schoolData.teachers);
    allClasses.sort(() => Math.random() - 0.5).forEach(className => {
      const division = this._getClassDivision(className);
      const teacher = this._getTeacherForClassSubject(className, subject);
      const needed = this.schoolData.subjects[division]?.[subject];
      if (teacher && needed !== undefined && needed > 0) {
        let scheduled = this._getScheduledPeriods(className, subject);
        let periodsToSchedule = needed - scheduled;
        const lessonDetails = { className, subject, teacher };
        const rule = this.constraints.doublePeriodSubjects.find(r => r.subject === subject && r.divisions.includes(division));
        if (scheduleAsDoubleOnly) {
          while (periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
            } else {
              this.unassignedLessons.push({ className, subject, periodsRemaining: periodsToSchedule, reason: `Failed to schedule mandatory double period for ${subject} (class: ${className})` });
              break;
            }
          }
          if (periodsToSchedule > 0) {
            this.unassignedLessons.push({ className, subject, periodsRemaining: periodsToSchedule, reason: `Remaining ${periodsToSchedule} periods for ${subject} (class: ${className}) could not be scheduled as doubles.` });
          }
        } else if (rule && rule.strict === 'mixed' && rule.structure) {
          let doublesScheduled = 0;
          while (doublesScheduled < rule.structure.doubles && periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
              doublesScheduled++;
            } else {
              break;
            }
          }
          let singlesScheduled = 0;
          while (singlesScheduled < rule.structure.singles && periodsToSchedule >= 1) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
              periodsToSchedule -= 1;
              singlesScheduled++;
            } else {
              break;
            }
          }
          while (periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
            } else {
              if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
                periodsToSchedule -= 1;
              } else {
                break;
              }
            }
          }
          while (periodsToSchedule >= 1) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
              periodsToSchedule -= 1;
            } else {
              break;
            }
          }
          if (periodsToSchedule > 0) {
            this.unassignedLessons.push({ className, subject, periodsRemaining: periodsToSchedule, reason: `Failed to schedule some periods for ${subject} (class: ${className}) using mixed structure.` });
          }
        } else {
          while (periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
            } else {
              break;
            }
          }
          while (periodsToSchedule > 0) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
              periodsToSchedule--;
            } else {
              this.unassignedLessons.push({ className, subject, periodsRemaining: periodsToSchedule, reason: `Failed to schedule remaining single periods for ${subject} (class: ${className})` });
              break;
            }
          }
        }
      }
    });
  }

  _scheduleSpecialEvents() {
    this.schoolData.specialEvents.forEach(event => {
      this.schoolData.days.forEach(day => {
        if (event.day === day) {
          const periodIds = Array.isArray(event.periodIds) ? event.periodIds : [event.periodId];
          Object.keys(this.timetables).forEach(className => {
            const division = this._getClassDivision(className);
            if (event.appliesTo === 'all' || (Array.isArray(event.appliesTo) && event.appliesTo.includes(division))) {
              periodIds.forEach(periodId => {
                if (!this.timetables[className][day][periodId]) {
                  this.timetables[className][day][periodId] = { type: "event", name: event.name, color: event.color };
                }
              });
            }
          });
        }
      });
    });
  }

  _scheduleRestrictedSubjects() {
    if (this.constraints.subjectRestrictions) {
      Object.entries(this.constraints.subjectRestrictions).forEach(([subject, rule]) => {
        this._scheduleAllForSubject(subject, rule.days);
      });
    }
  }

  _scheduleSingleResourceSubjects() {
    if (Array.isArray(this.constraints.singleResourceSubjects)) {
      this.constraints.singleResourceSubjects.forEach(subject => {
        this._scheduleAllForSubject(subject);
      });
    }
  }

  _scheduleStrictDoublePeriodSubjects() {
    if (Array.isArray(this.constraints.doublePeriodSubjects)) {
      this.constraints.doublePeriodSubjects.filter(r => r.strict === true && r.subject !== "P.E.").forEach(rule => {
        this._scheduleAllForSubject(rule.subject, this.schoolData.days, true);
      });
    }
  }

  _schedulePE() {
    this._scheduleAllForSubject("P.E.", this.schoolData.days, true);
  }

  _scheduleRemainingLessons() {
    const allSubjects = [...new Set(Object.values(this.schoolData.subjects).flatMap(div => Object.keys(div)))];
    const subjectsToSkip = new Set();
    if (this.constraints.subjectRestrictions) Object.keys(this.constraints.subjectRestrictions).forEach(s => subjectsToSkip.add(s));
    if (Array.isArray(this.constraints.singleResourceSubjects)) this.constraints.singleResourceSubjects.forEach(s => subjectsToSkip.add(s));
    if (Array.isArray(this.constraints.doublePeriodSubjects)) this.constraints.doublePeriodSubjects.filter(r => r.strict === true).forEach(r => subjectsToSkip.add(r.subject));
    subjectsToSkip.add("P.E.");
    allSubjects.filter(subject => !subjectsToSkip.has(subject))
      .sort((a, b) => {
        const ruleA = this.constraints.doublePeriodSubjects.find(r => r.subject === a && r.strict === 'mixed');
        const ruleB = this.constraints.doublePeriodSubjects.find(r => r.subject === b && r.strict === 'mixed');
        if (ruleA && !ruleB) return -1;
        if (!ruleA && ruleB) return 1;
        return 0;
      })
      .forEach(subject => this._scheduleAllForSubject(subject));
  }

  _injectBreakAndLunch() {
    Object.keys(this.timetables).forEach(className => {
      const breakPeriod = this._getBreakPeriod(className);
      const lunchPeriod = this._getLunchPeriod(className);
      this.schoolData.days.forEach(day => {
        if (breakPeriod !== undefined && !this.timetables[className][day][breakPeriod]) {
          this.timetables[className][day][breakPeriod] = { type: "break", name: "Break" };
        }
        if (lunchPeriod !== undefined && !this.timetables[className][day][lunchPeriod]) {
          this.timetables[className][day][lunchPeriod] = { type: "lunch", name: "Lunch" };
        }
      });
    });
  }

  _fillEmptySlots() {
    Object.keys(this.timetables).forEach(className => {
      const lessonSlots = this._getLessonSlotsForClass(className);
      const allPeriods = this.schoolData.periods.map(p => p.id);
      this.schoolData.days.forEach(day => {
        allPeriods.forEach(periodId => {
          if (!this.timetables[className][day][periodId]) {
            if (lessonSlots.includes(periodId)) {
              this.timetables[className][day][periodId] = { type: "free", name: "Free Period" };
            } else {
              if (this.schoolData.periods.find(p => p.id === periodId && p.type === "arrival")) {
                this.timetables[className][day][periodId] = { type: "arrival", name: "Arrival" };
              } else {
                this.timetables[className][day][periodId] = { type: "free", name: "Free" };
              }
            }
          }
        });
      });
    });
  }

  _validateTimetable() {
    let validationPassed = true;
    Object.keys(this.schoolData.teachers).forEach(className => {
      const division = this._getClassDivision(className);
      const subjectsNeeded = this.schoolData.subjects[division];
      if (!subjectsNeeded) return;
      Object.entries(subjectsNeeded).forEach(([subject, neededPeriods]) => {
        const scheduledPeriods = this._getScheduledPeriods(className, subject);
        if (scheduledPeriods !== neededPeriods) {
          validationPassed = false;
        }
      });
    });
    if (this.unassignedLessons.length > 0) {
      validationPassed = false;
    }
    this.schoolData.days.forEach(day => {
      this.schoolData.periods.forEach(period => {
        const globalSlot = this.globalSchedule[day][period.id];
        if (globalSlot.teachers.size > 1) {
          validationPassed = false;
        }
      });
    });
    this.schoolData.days.forEach(day => {
      this.schoolData.periods.forEach(period => {
        const bookedBy = this.globalSchedule[day][period.id].resources.ICT;
        if (bookedBy) {
          const classesWithIctAtThisTime = Object.keys(this.timetables).filter(className =>
            this.timetables[className][day][period.id]?.subject === "ICT"
          );
          if (classesWithIctAtThisTime.length > 1) {
            validationPassed = false;
          }
        }
      });
    });
    if (validationPassed) {
      // Optionally log or notify that validation passed
    }
  }
}

if (typeof module !== "undefined") {
  module.exports = TimetableGenerator;
}
