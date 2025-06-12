require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');
const fetch = require('node-fetch');

// Configure AWS
AWS.config.update({
    region: process.env.AWS_REGION || 'us-east-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const s3 = new AWS.S3();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from the static directory
app.use(express.static('static'));
app.use(express.json({ limit: '50mb' }));

// Store active processes
const activeProcesses = new Map();

// Function to parse CSV data
function parseCSVData(csvData) {
    try {
        console.log('Parsing CSV data:', csvData);
        const lines = csvData.split('\n').filter(line => line.trim());
        return lines.map(line => {
            const [url, name, ...tags] = line.split(',').map(item => item.trim());
            return { url, name, tags: tags.filter(tag => tag) };
        });
    } catch (error) {
        console.error('Error parsing CSV data:', error);
        throw new Error(`Failed to parse CSV: ${error.message}`);
    }
}

// Function to generate unique product ID
function generateProductId() {
    const id = Math.floor(100000 + Math.random() * 900000);
    return `AA${id}`;
}

// Function to download image from S3
async function downloadImageFromS3(url, localPath) {
    try {
        console.log(`Downloading image from ${url} to ${localPath}`);
        const response = await fetch(url);
        const buffer = await response.buffer();
        fs.writeFileSync(localPath, buffer);
        console.log(`Successfully downloaded image to ${localPath}`);
        return localPath;
    } catch (error) {
        console.error('Error downloading image:', error);
        throw new Error(`Failed to download image: ${error.message}`);
    }
}

// Function to run Python script with proper error handling
function runPythonScript(scriptPath, args, socket) {
    return new Promise((resolve, reject) => {
        console.log(`Running Python script: ${scriptPath} with args:`, args);
        // Use the full path to Python
        const pythonPath = "C:\\Program Files\\Python313\\python.exe";
        console.log(`Using Python at: ${pythonPath}`);
        
        const pythonProcess = spawn(pythonPath, [scriptPath, ...args], {
            env: { 
                ...process.env, 
                PYTHONUNBUFFERED: '1',
                AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
                AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
                AWS_REGION: process.env.AWS_REGION || 'us-east-2'
            }
        });
        
        let stdoutData = '';
        let stderrData = '';

        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            stdoutData += output;
            console.log(`Python stdout: ${output}`);
            if (socket) {
                socket.emit('processingProgress', { 
                    type: path.basename(scriptPath, '.py'),
                    output 
                });
            }
        });

        pythonProcess.stderr.on('data', (data) => {
            const output = data.toString();
            stderrData += output;
            
            // Check if this is an actual error or just logging
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.trim()) {  // Skip empty lines
                    if (line.includes('ERROR -') || line.includes('CRITICAL -')) {
                        // This is an actual error
                        console.error(`Python error: ${line}`);
                        if (socket) {
                            socket.emit('processingError', {
                                type: path.basename(scriptPath, '.py'),
                                error: line
                            });
                        }
                    } else if (line.includes('WARNING -')) {
                        // This is a warning
                        console.warn(`Python warning: ${line}`);
                        if (socket) {
                            socket.emit('processingWarning', {
                                type: path.basename(scriptPath, '.py'),
                                warning: line
                            });
                        }
                    } else {
                        // This is just informational logging
                        console.log(`Python info: ${line}`);
                        if (socket) {
                            socket.emit('processingProgress', {
                                type: path.basename(scriptPath, '.py'),
                                output: line
                            });
                        }
                    }
                }
            }
        });

        pythonProcess.on('error', (error) => {
            console.error('Failed to start Python process:', error);
            reject(new Error(`Failed to start Python process: ${error.message}`));
        });

        pythonProcess.on('close', (code) => {
            console.log(`Python script ${scriptPath} exited with code ${code}`);
            if (code === 0) {
                resolve({ stdout: stdoutData, stderr: stderrData });
            } else {
                // Only reject if there were actual errors in stderr
                const hasErrors = stderrData.split('\n').some(line => 
                    line.includes('ERROR -') || line.includes('CRITICAL -')
                );
                if (hasErrors) {
                    reject(new Error(`Python script exited with code ${code}\nStderr: ${stderrData}`));
                } else {
                    // If no actual errors, resolve with the output
                    resolve({ stdout: stdoutData, stderr: stderrData });
                }
            }
        });
    });
}

// Function to process images and generate PDFs
async function processImages(csvData, socket) {
    try {
        console.log('Starting image processing with data:', csvData);
        
        // Create timestamped directories
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const downloadDir = path.join(__dirname, 'Download', timestamp);
        const outputDir = path.join(__dirname, 'Output', timestamp);
        const printpanelsDir = path.join(__dirname, 'printpanels');
        const printpanelsOutputDir = path.join(printpanelsDir, 'output', timestamp);
        const csvDir = path.join(printpanelsDir, 'csv');
        
        // Ensure directories exist
        [downloadDir, outputDir, printpanelsOutputDir, csvDir].forEach(dir => {
            fs.mkdirSync(dir, { recursive: true });
        });

        // Save CSV data for both processes
        const csvPath = path.join(csvDir, 'meta_file_list.csv');
        fs.writeFileSync(csvPath, csvData);

        // Run Python script for image processing
        const imageScriptPath = path.join(__dirname, 'Scripts', 'images.py');
        console.log(`Running Python script: ${imageScriptPath} with CSV data`);
        
        try {
            // Pass the CSV data directly to the Python script
            await runPythonScript(imageScriptPath, [csvData], socket);
            console.log('Successfully processed images');
            
            // Emit completion event for image processing
            socket.emit('imageProcessingComplete', {
                status: 'success',
                message: 'Image processing completed successfully'
            });

            // Start PDF generation
            console.log('Starting PDF generation...');
            const pdfScriptPath = path.join(__dirname, 'Scripts', 'illustrator_process.py');
            
            try {
                // Run PDF generation script
                await runPythonScript(pdfScriptPath, [csvPath], socket);
                console.log('Successfully generated PDFs');
                
                // Emit completion event for PDF generation
                socket.emit('pdfGenerationComplete', {
                    status: 'success',
                    message: 'PDF generation completed successfully'
                });

                // Emit final completion event
                socket.emit('processComplete', {
                    success: true,
                    message: 'All processing completed successfully',
                    data: {
                        downloadDir,
                        outputDir,
                        printpanelsOutputDir,
                        csvPath
                    }
                });
            } catch (pdfError) {
                console.error('Error in PDF generation:', pdfError);
                socket.emit('pdfGenerationError', {
                    status: 'error',
                    message: pdfError.message
                });
                // Emit processComplete with success: false for PDF error
                socket.emit('processComplete', {
                    success: false,
                    error: pdfError.message
                });
                throw pdfError;
            }
        } catch (imageError) {
            console.error('Error in image processing:', imageError);
            socket.emit('imageProcessingError', {
                status: 'error',
                message: imageError.message
            });
            // Emit processComplete with success: false for image error
            socket.emit('processComplete', {
                success: false,
                error: imageError.message
            });
            throw imageError;
        }
    } catch (error) {
        console.error('Error in processImages:', error);
        socket.emit('processError', {
            status: 'error',
            message: error.message
        });
        // Emit processComplete with success: false for general error
        socket.emit('processComplete', {
            success: false,
            error: error.message
        });
        throw error;
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('startProcess', async (data) => {
        console.log('Start process request received:', data);
        
        try {
            if (!data.csvData) {
                throw new Error('No CSV data provided');
            }

            // Store the process with more detailed status
            activeProcesses.set(socket.id, {
                startTime: new Date(),
                status: 'running',
                stage: 'image_processing',
                progress: 0
            });

            // Start processing
            await processImages(data.csvData, socket);

            // Update process status
            const process = activeProcesses.get(socket.id);
            if (process) {
                process.status = 'completed';
                process.endTime = new Date();
                process.stage = 'completed';
                process.progress = 100;
            }

            // Emit final completion event
            socket.emit('processComplete', {
                success: true,
                message: 'All processing completed successfully',
                data: {
                    downloadDir,
                    outputDir,
                    printpanelsOutputDir,
                    csvPath
                }
            });
        } catch (error) {
            console.error('Error in startProcess:', error);
            socket.emit('processError', { 
                status: 'error', 
                message: error.message 
            });

            // Update process status
            const process = activeProcesses.get(socket.id);
            if (process) {
                process.status = 'failed';
                process.endTime = new Date();
                process.error = error.message;
            }

            // Emit processComplete with success: false
            socket.emit('processComplete', {
                success: false,
                error: error.message
            });
        }
    });

    // Add new event handlers for detailed progress tracking
    socket.on('processingProgress', (data) => {
        const process = activeProcesses.get(socket.id);
        if (process) {
            process.lastUpdate = new Date();
            process.lastMessage = data.output;
            
            // Update stage based on message content
            if (data.output.includes('PHOTOSHOP_COMPLETE')) {
                process.stage = 'pdf_generation';
                process.progress = 50;
            }
            
            socket.emit('processStatus', {
                stage: process.stage,
                progress: process.progress,
                message: data.output
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        activeProcesses.delete(socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('- AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'Set' : 'Not set');
    console.log('- AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'Not set');
    console.log('- AWS_REGION:', process.env.AWS_REGION || 'us-east-2');
});
