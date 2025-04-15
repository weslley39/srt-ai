"use client";

import React from "react";
import { libre, roaldDahl } from "@/fonts";

import Form from "@/components/Form";
import Timestamp from "@/components/Timestamp";

import type { Chunk } from "@/types";
import { parseSegment, parseTimestamp } from "@/lib/client";

function classNames(...classes: string[]) {
	return classes.filter(Boolean).join(" ");
}

const triggerFileDownload = (filename: string, content: string) => {
	const element = document.createElement("a");
	const file = new Blob([content], { type: "text/plain" });
	element.href = URL.createObjectURL(file);
	element.download = filename;
	document.body.appendChild(element);
	element.click();
};

interface TranslationStatus {
	fileName: string;
	fileIndex: number;
	status: 'pending' | 'translating' | 'complete' | 'error';
	progress: number;
	content: string;
}

function Translating({ filesStatus }: { filesStatus: TranslationStatus[] }) {
	return (
		<div className="w-full max-w-lg">
			{filesStatus.map((file) => (
				<div key={file.fileIndex} className="mb-4 bg-white p-4 rounded-lg shadow">
					<div className="flex justify-between items-center mb-2">
						<div className="font-medium truncate max-w-[70%] text-sm" title={file.fileName}>{file.fileName}</div>
						<div className="text-sm whitespace-nowrap ml-2">
							{file.status === 'pending' && <span className="text-gray-500">Pending...</span>}
							{file.status === 'translating' && <span className="text-blue-500">Translating...</span>}
							{file.status === 'complete' && <span className="text-green-500">Complete!</span>}
							{file.status === 'error' && <span className="text-red-500">Error</span>}
						</div>
					</div>
					<div className="w-full bg-gray-200 rounded-full h-2.5">
						<div
							className={`h-2.5 rounded-full ${file.status === 'complete' ? 'bg-green-500' : 'bg-blue-500'}`}
							style={{ width: `${file.progress}%` }}
						></div>
					</div>
				</div>
			))}
		</div>
	);
}

export default function Home() {
	const [status, setStatus] = React.useState<"idle" | "busy" | "done">("idle");
	const [filesStatus, setFilesStatus] = React.useState<TranslationStatus[]>([]);
	const [translatedSrt, setTranslatedSrt] = React.useState("");
	const [translatedChunks, setTranslatedChunks] = React.useState<Chunk[]>([]);
	const [originalChunks, setOriginalChunks] = React.useState<Chunk[]>([]);
	const [totalFilesProcessed, setTotalFilesProcessed] = React.useState(0);
	const [totalFiles, setTotalFiles] = React.useState(0);

	async function handleStream(response: Response, files: Array<{name: string}>, language: string) {
		const data = response.body;
		if (!data) return;

		// Initialize file status tracking
		setFilesStatus(files.map((file, index) => ({
			fileName: file.name,
			fileIndex: index,
			status: 'pending',
			progress: 0,
			content: ''
		})));

		setTotalFiles(files.length);
		setTotalFilesProcessed(0);

		let doneReading = false;
		const reader = data.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (!doneReading) {
			const { value, done } = await reader.read();
			doneReading = done;

			if (done) break;

			const text = decoder.decode(value);
			buffer += text;

			// Process each line in the buffer
			const lines = buffer.split("\n");
			buffer = lines.pop() || ""; // Keep the last incomplete line in the buffer

			for (const line of lines) {
				if (!line.trim()) continue;

				try {
					const message = JSON.parse(line);

					switch (message.type) {
						case "file_start":
							setFilesStatus(prev => prev.map(file =>
								file.fileIndex === message.fileIndex
									? { ...file, status: 'translating', progress: 5 }
									: file
							));
							break;

						case "chunk":
							// Update the file's progress and content
							setFilesStatus(prev => prev.map(file => {
								if (file.fileIndex === message.fileIndex) {
									const newContent = file.content + message.content;
									// Calculate progress based on content length and estimate
									const progress = Math.min(5 + (newContent.length / 500) * 95, 95);
									return {
										...file,
										content: newContent,
										progress: progress
									};
								}
								return file;
							}));

							// Add to translation display
							if (message.content.trim().length) {
								const chunk = parseChunk(message.content);
								setTranslatedChunks(prev => [...prev, chunk]);
							}
							break;

						case "file_complete":
							// Mark file as complete and trigger download
							setFilesStatus(prev => prev.map(file =>
								file.fileIndex === message.fileIndex
									? { ...file, status: 'complete', progress: 100, content: message.content }
									: file
							));

							// Create filename based on original name and target language
							const fileNameWithoutExt = message.fileName.replace(/\.srt$/, '');
							const filename = `${fileNameWithoutExt}_${language}.srt`;

							triggerFileDownload(filename, message.content);
							setTotalFilesProcessed(prev => prev + 1);
							break;

						case "file_error":
							setFilesStatus(prev => prev.map(file =>
								file.fileIndex === message.fileIndex
									? { ...file, status: 'error', progress: 100 }
									: file
							));
							setTotalFilesProcessed(prev => prev + 1);
							break;

						case "all_complete":
							// All files have been processed
							setStatus("done");
							break;

						case "error":
							console.error("API error:", message.message);
							setStatus("idle");
							break;
					}
				} catch (e) {
					console.error("Error parsing message:", e, line);
				}
			}
		}

		function parseChunk(chunkStr: string): Chunk {
			try {
				const { id, timestamp, text } = parseSegment(chunkStr);
				const { start, end } = parseTimestamp(timestamp);
				return { index: id.toString(), start, end, text };
			} catch (e) {
				console.error("Error parsing chunk:", e);
				return { index: "0", start: "00:00:00,000", end: "00:00:00,100", text: chunkStr };
			}
		}
	}

	async function handleSubmit(files: Array<{content: string, name: string}>, language: string) {
		try {
			if (files.length === 0) {
				console.error("No files provided");
				return;
			}

			setStatus("busy");
			// Reset previous state
			setTranslatedSrt("");
			setTranslatedChunks([]);
			setOriginalChunks([]);

			// Process all files at once via the updated API
			const response = await fetch("/api", {
				method: "POST",
				body: JSON.stringify({
					files: files.map(file => ({
						content: file.content,
						name: file.name
					})),
					language
				}),
				headers: { "Content-Type": "application/json" },
			});

			if (response.ok) {
				await handleStream(response, files, language);
			} else {
				setStatus("idle");
				console.error("Error occurred while submitting the translation request");
			}
		} catch (error) {
			setStatus("idle");
			console.error(
				"Error during file translation request:",
				error
			);
		}
	}

	return (
		<main
			className={classNames(
				"max-w-2xl flex flex-col items-center mx-auto",
				libre.className,
			)}
		>
			{status === "idle" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						Translate any SRT, to any language
					</h1>
					<Form onSubmit={handleSubmit} />
				</>
			)}
			{status === "busy" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						Translating&hellip;
					</h1>
					<p className="mb-6">Translating {totalFilesProcessed}/{totalFiles} files</p>
					<Translating filesStatus={filesStatus} />
				</>
			)}
			{status === "done" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						All done!
					</h1>
					<p>Check your "Downloads" folder 🍿</p>
					<p className="mt-4 text-[#444444]">
						Psst. Need to edit your SRT? Try{" "}
						<a
							href="https://www.veed.io/subtitle-tools/edit?locale=en&source=/tools/subtitle-editor/srt-editor"
							target="_blank"
							rel="noreferrer"
						>
							this tool
						</a>
					</p>
				</>
			)}
		</main>
	);
}
