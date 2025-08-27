// --- FILE: generator.worker.js ---

// This file runs in a background thread and will not block the UI.

// First, we need to import the generator class.
// Since workers can't access the DOM, we can't use a <script> tag.
// We use importScripts() to load the generator's code.
importScripts('timetable-generator.js');

// Listen for messages from the main app.js file.
self.onmessage = (event) => {
    // The main thread will send the school data when it's time to generate.
    const { schoolData, constraints } = event.data;
    
    console.log("Worker: Received data. Starting generation...");

    // Instantiate the generator with the provided data.
    const generator = new TimetableGenerator(schoolData, constraints);
    
    // Run the generation process. This might take a few seconds.
    const timetables = generator.generate();
    const unassigned = generator.unassignedLessons;
    
    console.log("Worker: Generation complete. Sending results back to main thread.");

    // Send the results back to the main app.js file.
    self.postMessage({
        type: 'result',
        timetables,
        unassigned
    });
};