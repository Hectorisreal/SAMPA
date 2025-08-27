class TimetableGenerator {
  constructor(schoolData, constraints) {
    this.schoolData = schoolData;
    this.constraints = constraints;
    this.timetables = {}; // Stores the final timetable for each class
    this.globalSchedule = {}; // Tracks overall teacher and resource availability
    this.unassignedLessons = []; // Stores lessons that couldn't be scheduled
    this.teacherStats = {}; // Tracks workload for each teacher
  }

  generate() {
    console.log("Generator: Starting timetable generation process...");
    this._initialize();
    this._scheduleSpecialEvents(); // Schedule fixed events first
    this._scheduleRestrictedSubjects(); // Schedule subjects with specific day restrictions (e.g., Robotics)
    this._scheduleSingleResourceSubjects(); // Schedule subjects using a single resource (e.g., ICT)
    this._scheduleStrictDoublePeriodSubjects(); // Schedule subjects that *must* be double periods
    this._schedulePE(); // Schedule P.E. as a special case for doubles
    this._scheduleRemainingLessons(); // Schedule all other lessons
    this._injectBreakAndLunch(); // Add break and lunch after all lessons are placed
    this._fillEmptySlots(); // Fill any remaining empty slots with 'Free'

    console.log(`Generator: Process complete. ${this.unassignedLessons.length} unassigned lesson groups.`);
    this._printTeacherStats();
    this._validateTimetable(); // Add a validation step
    return this.timetables;
  }

  _initialize() {
    this.unassignedLessons = [];
    this.teacherStats = {};

    // Initialize timetables for each class and global schedule
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
          resources: { ICT: null } // Explicitly track ICT lab
        };
      });
    });

    // Initialize teacher stats
    const teacherSet = new Set(Object.values(this.schoolData.teachers).flatMap(Object.values).flatMap(t => Array.isArray(t) ? t : [t]));
    teacherSet.forEach(teacher => {
      this.teacherStats[teacher] = { totalPeriods: 0, dailyPeriods: {} };
      this.schoolData.days.forEach(day => this.teacherStats[teacher].dailyPeriods[day] = 0);
    });

    // Pre-calculate total periods for each teacher (for validation/overview)
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

  // Helper to determine class division (e.g., 'Year 1' -> 'lowerPrimary')
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

  // Helper to get the teacher name, handling arrays if present
  _getTeacherForClassSubject(className, subject) {
    let teacher = this.schoolData.teachers[className]?.[subject];
    return Array.isArray(teacher) ? teacher[0] : teacher; // Use the first teacher if multiple are listed
  }

  // Get available lesson slots for a class on a given day
  _getAvailableLessonSlots(className, day) {
    const division = this._getClassDivision(className);
    return [...(this.schoolData.divisionSchedules[division]?.lessonSlots || [])];
  }

  // Count how many times a subject is scheduled for a class on a specific day
  _countSubjectOnDay(className, subject, day) {
    return Object.values(this.timetables[className][day]).filter(item => item.subject === subject).length;
  }

  // Count how many times a subject is scheduled for a class in total
  _getScheduledPeriods(className, subject) {
    return this.schoolData.days.reduce((acc, day) => acc + this._countSubjectOnDay(className, subject, day), 0);
  }

  // Check if a lesson can be assigned to a specific slot
  canAssignLesson(className, subject, teacher, day, slot) {
    const { workloadLimits, teacherAvailability, subjectRestrictions } = this.constraints;
    const division = this._getClassDivision(className);

    // Skip if the slot is outside valid lesson slots for the division
    const divisionLessonSlots = this._getAvailableLessonSlots(className, day);
    if (!divisionLessonSlots.includes(slot)) {
      return { valid: false, reason: `Slot ${slot} is not a valid lesson slot for ${division}` };
    }

    // Check if the slot is already taken by another lesson in the class timetable
    if (this.timetables[className][day][slot] && this.timetables[className][day][slot].type === undefined) {
      return { valid: false, reason: `Class slot ${slot} already booked by ${this.timetables[className][day][slot].subject}` };
    }

    // Check teacher workload limits
    if (this.teacherStats[teacher]) {
      const maxPeriods = this.constraints.teacherWorkloadExceptions.includes(teacher)
        ? workloadLimits.maxTeacherPeriodsPerDayException
        : workloadLimits.maxTeacherPeriodsPerDay;

      if (this.teacherStats[teacher].dailyPeriods[day] >= maxPeriods) {
        return { valid: false, reason: `Teacher ${teacher} daily workload exceeded on ${day}` };
      }
      // Check if teacher is already booked globally for this slot
      if (this.globalSchedule[day][slot].teachers.has(teacher)) {
        return { valid: false, reason: `Teacher ${teacher} already booked globally at ${day} P${slot}` };
      }
    } else {
      // If teacher is not in stats, it might be a general class teacher or an issue
      // For now, allow but log. Could be a "class teachers" entry.
      // console.warn(`Teacher ${teacher} for ${subject} in ${className} not found in teacherStats.`);
    }

    // Check teacher availability rules (e.g., part-time days)
    const availabilityRule = teacherAvailability[teacher];
    if (availabilityRule) {
      if (availabilityRule.availableDays && !availabilityRule.availableDays.includes(day)) {
        return { valid: false, reason: `Teacher ${teacher} not available on ${day}` };
      }
      if (availabilityRule.unavailableDays && availabilityRule.unavailableDays.includes(day)) {
        return { valid: false, reason: `Teacher ${teacher} specifically unavailable on ${day}` };
      }
    }

    // Check subject-specific day restrictions
    const subjectRule = subjectRestrictions[subject];
    if (subjectRule && subjectRule.days && !subjectRule.days.includes(day)) {
      return { valid: false, reason: `Subject ${subject} restricted to specific days, and ${day} is not one of them.` };
    }

    // ICT lab resource check
    if (subject === "ICT" && this.globalSchedule[day][slot].resources["ICT"]) {
      return { valid: false, reason: `ICT lab booked by ${this.globalSchedule[day][slot].resources["ICT"]} at ${day} P${slot}` };
    }

    return { valid: true };
  }

  // Assign a lesson to a slot in the timetable
  assignLesson(className, subject, teacher, day, slot) {
    if (this.timetables[className][day][slot]) {
      // This should ideally not happen if canAssignLesson is used correctly, but good for debugging
      console.warn(`Overwriting existing entry for ${className} on ${day} P${slot}: ${JSON.stringify(this.timetables[className][day][slot])} with ${subject}`);
    }
    this.timetables[className][day][slot] = { subject, teacher };
    if (teacher) { // Only add if it's a specific teacher, not 'class teachers'
      this.globalSchedule[day][slot].teachers.add(teacher);
      if (this.teacherStats[teacher]) {
        this.teacherStats[teacher].dailyPeriods[day]++;
      }
    }
    if (subject === "ICT") {
      this.globalSchedule[day][slot].resources["ICT"] = className;
    }
  }

  // Core scheduling logic for a block of periods (single or double)
  _scheduleLessonBlock({ className, subject, teacher }, allowedDays, numPeriods) {
    const shuffledDays = [...allowedDays].sort(() => Math.random() - 0.5); // Randomize days
    const division = this._getClassDivision(className);
    const lessonSlots = this._getAvailableLessonSlots(className, shuffledDays[0]); // Get once per division

    for (const day of shuffledDays) {
      // Filter slots to only include actual lesson periods and exclude those already filled
      const availableSlotsOnDay = lessonSlots.filter(slot =>
        !this.timetables[className][day][slot] && // Class slot must be empty
        !this.schoolData.specialEvents.some(e => e.day === day && (e.periodId === slot || (Array.isArray(e.periodIds) && e.periodIds.includes(slot)))) // Not a special event
      ).sort(() => Math.random() - 0.5); // Randomize slot order

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
        // Prioritize consecutive slots
        for (let i = 0; i < availableSlotsOnDay.length - 1; i++) {
          const s1 = availableSlotsOnDay[i];
          const s2 = availableSlotsOnDay[i + 1];

          // Check if slots are truly consecutive
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
        // If no consecutive, try to find two available slots on the same day, not necessarily consecutive
        // This is a fallback and might not always be ideal for "double periods" but ensures they are scheduled
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

  // Helper to schedule all required periods for a given subject across all classes
  _scheduleAllForSubject(subject, allowedDays = this.schoolData.days, scheduleAsDoubleOnly = false) {
    const allClasses = Object.keys(this.schoolData.teachers);
    // Shuffle classes to ensure fair distribution for single-resource subjects
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
          // Schedule doubles first based on structure
          let doublesScheduled = 0;
          while (doublesScheduled < rule.structure.doubles && periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
              doublesScheduled++;
            } else {
              break; // Couldn't schedule a double, try singles
            }
          }
          // Then schedule singles
          let singlesScheduled = 0;
          while (singlesScheduled < rule.structure.singles && periodsToSchedule >= 1) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
              periodsToSchedule -= 1;
              singlesScheduled++;
            } else {
              break; // Couldn't schedule a single
            }
          }
          // If still periods remaining, try to schedule remaining as either singles or doubles if possible
          while (periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
            } else {
              // If not a double, try single
              if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
                periodsToSchedule -= 1;
              } else {
                break; // Can't schedule anything more
              }
            }
          }
          while (periodsToSchedule >= 1) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 1)) {
              periodsToSchedule -= 1;
            } else {
              break; // Can't schedule anything more
            }
          }
          if (periodsToSchedule > 0) {
            this.unassignedLessons.push({ className, subject, periodsRemaining: periodsToSchedule, reason: `Failed to schedule some periods for ${subject} (class: ${className}) using mixed structure.` });
          }
        } else {
          // Default: schedule as many doubles as possible, then singles
          while (periodsToSchedule >= 2) {
            if (this._scheduleLessonBlock(lessonDetails, allowedDays, 2)) {
              periodsToSchedule -= 2;
            } else {
              break; // Couldn't schedule a double, try singles
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

  // Step 1: Schedule fixed special events (Worship, Clubs/Activities)
  _scheduleSpecialEvents() {
    console.log("Generator Step 1: Scheduling special events...");
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
                } else {
                  console.warn(`Event ${event.name} conflicts with existing entry for ${className} on ${day} P${periodId}: ${JSON.stringify(this.timetables[className][day][periodId])}`);
                }
              });
            }
          });
        }
      });
    });
  }

  // Step 2: Schedule subjects with explicit day restrictions (e.g., Robotics)
  _scheduleRestrictedSubjects() {
    console.log("Generator Step 2: Scheduling strictly restricted subjects (e.g., Robotics)...");
    if (this.constraints.subjectRestrictions) {
      Object.entries(this.constraints.subjectRestrictions).forEach(([subject, rule]) => {
        this._scheduleAllForSubject(subject, rule.days);
      });
    }
  }

  // Step 3: Schedule subjects that use a single shared resource (e.g., ICT Lab)
  _scheduleSingleResourceSubjects() {
    console.log("Generator Step 3: Scheduling single resource subjects (e.g., ICT)...");
    if (Array.isArray(this.constraints.singleResourceSubjects)) {
      this.constraints.singleResourceSubjects.forEach(subject => {
        this._scheduleAllForSubject(subject);
      });
    }
  }

  // Step 4: Schedule subjects that MUST be strict double periods (e.g., Art, Music)
  _scheduleStrictDoublePeriodSubjects() {
    console.log("Generator Step 4: Scheduling strict double period subjects (e.g., Art, Music)...");
    if (Array.isArray(this.constraints.doublePeriodSubjects)) {
      this.constraints.doublePeriodSubjects.filter(r => r.strict === true && r.subject !== "P.E.").forEach(rule => {
        this._scheduleAllForSubject(rule.subject, this.schoolData.days, true); // Enforce as doubles
      });
    }
  }

  // Step 5: Schedule P.E. as a special case for strict doubles (handled separately due to specific rule in data)
  _schedulePE() {
    console.log("Generator Step 5: Scheduling P.E. lessons...");
    this._scheduleAllForSubject("P.E.", this.schoolData.days, true); // P.E. must be scheduled as doubles
  }

  // Step 6: Schedule all other remaining lessons
  _scheduleRemainingLessons() {
    console.log("Generator Step 6: Scheduling all remaining lessons...");
    const allSubjects = [...new Set(Object.values(this.schoolData.subjects).flatMap(div => Object.keys(div)))];
    const subjectsToSkip = new Set();

    // Collect subjects already handled in previous steps
    if (this.constraints.subjectRestrictions) Object.keys(this.constraints.subjectRestrictions).forEach(s => subjectsToSkip.add(s));
    if (Array.isArray(this.constraints.singleResourceSubjects)) this.constraints.singleResourceSubjects.forEach(s => subjectsToSkip.add(s));
    if (Array.isArray(this.constraints.doublePeriodSubjects)) this.constraints.doublePeriodSubjects.filter(r => r.strict === true).forEach(r => subjectsToSkip.add(r.subject));
    subjectsToSkip.add("P.E."); // P.E. is handled

    // Schedule remaining subjects, prioritizing those with mixed strict rules first, then others
    allSubjects.filter(subject => !subjectsToSkip.has(subject))
      .sort((a, b) => {
        const ruleA = this.constraints.doublePeriodSubjects.find(r => r.subject === a && r.strict === 'mixed');
        const ruleB = this.constraints.doublePeriodSubjects.find(r => r.subject === b && r.strict === 'mixed');
        if (ruleA && !ruleB) return -1; // Mixed strict subjects first
        if (!ruleA && ruleB) return 1;
        return 0; // Otherwise, maintain original order
      })
      .forEach(subject => this._scheduleAllForSubject(subject));
  }

  // Inject break and lunch periods into the timetables
  _injectBreakAndLunch() {
    console.log("Generator Step 7: Injecting break and lunch periods...");
    Object.keys(this.timetables).forEach(className => {
      const division = this._getClassDivision(className);
      const { breakPeriod, lunchPeriod } = this.schoolData.divisionSchedules[division] || {};

      this.schoolData.days.forEach(day => {
        // Ensure break/lunch periods are only added if the slot is empty
        // Special events take precedence
        if (breakPeriod !== undefined && !this.timetables[className][day][breakPeriod]) {
          this.timetables[className][day][breakPeriod] = { type: "break", name: "Break" };
        }
        if (lunchPeriod !== undefined && !this.timetables[className][day][lunchPeriod]) {
          this.timetables[className][day][lunchPeriod] = { type: "lunch", name: "Lunch" };
        }
      });
    });
  }

  // Fill any empty slots with "Free"
  _fillEmptySlots() {
    console.log("Generator Step 8: Filling empty slots with 'Free'...");
    Object.keys(this.timetables).forEach(className => {
      const division = this._getClassDivision(className);
      const divisionSlots = this.schoolData.divisionSchedules[division]?.lessonSlots || [];
      const allPeriods = this.schoolData.periods.map(p => p.id);

      this.schoolData.days.forEach(day => {
        allPeriods.forEach(periodId => {
          if (!this.timetables[className][day][periodId]) {
            // Check if it's a valid lesson slot for the division or just a general free period
            if (divisionSlots.includes(periodId)) {
                this.timetables[className][day][periodId] = { type: "free", name: "Free Period" };
            } else {
                // For periods outside the normal lesson slots, can be considered free or just empty
                // For now, let's just mark them 'Free' for completeness if they are not arrival.
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

  // Validation step to check if all lessons were scheduled
  _validateTimetable() {
    console.log("\n--- Timetable Validation ---");
    let validationPassed = true;

    Object.keys(this.schoolData.teachers).forEach(className => {
      const division = this._getClassDivision(className);
      const subjectsNeeded = this.schoolData.subjects[division];
      if (!subjectsNeeded) return;

      Object.entries(subjectsNeeded).forEach(([subject, neededPeriods]) => {
        const scheduledPeriods = this._getScheduledPeriods(className, subject);
        if (scheduledPeriods !== neededPeriods) {
          console.error(`ERROR: ${className} - Subject '${subject}' needs ${neededPeriods} periods, but only ${scheduledPeriods} were scheduled.`);
          validationPassed = false;
        }
      });
    });

    if (this.unassignedLessons.length > 0) {
      console.error(`ERROR: ${this.unassignedLessons.length} lessons could not be assigned.`);
      this.unassignedLessons.forEach(lesson => console.error(`  - ${lesson.className}, ${lesson.subject}: ${lesson.periodsRemaining} periods remaining. Reason: ${lesson.reason}`));
      validationPassed = false;
    }

    // Check for double bookings (teacher or ICT lab)
    this.schoolData.days.forEach(day => {
      this.schoolData.periods.forEach(period => {
        const globalSlot = this.globalSchedule[day][period.id];
        if (globalSlot.teachers.size > 1) {
          console.error(`ERROR: Teacher conflict at ${day} P${period.id}. Teachers: ${Array.from(globalSlot.teachers).join(", ")}`);
          validationPassed = false;
        }
        if (globalSlot.resources.ICT && globalSlot.teachers.size > 0 && Array.from(globalSlot.teachers).some(t => t !== this._getTeacherForClassSubject(globalSlot.resources.ICT, "ICT"))) {
          // This check might be too strict if ICT teacher is not explicitly tracked for ICT resource.
          // Better: just check if ICT resource is assigned to more than one class.
        }
      });
    });

    // Cross-check ICT lab for multiple bookings
    this.schoolData.days.forEach(day => {
        this.schoolData.periods.forEach(period => {
            const bookedBy = this.globalSchedule[day][period.id].resources.ICT;
            if (bookedBy) {
                // Find all classes that have ICT scheduled at this time
                const classesWithIctAtThisTime = Object.keys(this.timetables).filter(className =>
                    this.timetables[className][day][period.id]?.subject === "ICT"
                );
                if (classesWithIctAtThisTime.length > 1) {
                    console.error(`ERROR: ICT Lab double booked at ${day} P${period.id} by classes: ${classesWithIctAtThisTime.join(", ")}`);
                    validationPassed = false;
                }
            }
        });
    });


    if (validationPassed) {
      console.log("Validation: All checks passed. Timetable seems consistent.");
    } else {
      console.log("Validation: Issues found in the generated timetable.");
    }
    console.log("----------------------------");
  }

  _printTeacherStats() {
    console.log("\n--- Teacher Workload Summary ---");
    const sorted = Object.entries(this.teacherStats)
      .sort((a, b) => (b[1].totalPeriods || 0) - (a[1].totalPeriods || 0));
    sorted.forEach(([teacher, stats]) => {
      const dailyLoads = Object.entries(stats.dailyPeriods).map(([day, p]) => `${day.substr(0, 1)}:${p}`).join(" ");
      console.log(`  ${teacher.padEnd(25)}: ${stats.totalPeriods} total | ${dailyLoads}`);
    });
    console.log("---------------------------------");
  }
}
