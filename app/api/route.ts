import { groupSegmentsByTokenLength } from "@/lib/srt";
import { parseSegment } from "@/lib/client";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

export const dynamic = "force-dynamic";

const MAX_TOKENS_IN_SEGMENT = 700;

const retrieveTranslation = async (text: string, language: string) => {
	let retries = 3;
	while (retries > 0) {
		try {
			const { text: translatedText } = await generateText({
				model: google("gemini-2.0-flash-exp"),
				messages: [
					{
						role: "system",
						content:
							"You are an experienced semantic translator, specialized in creating SRT files. Separate translation segments with the '|' symbol",
					},
					{
						role: "user",
						content: `Translate this to ${language}: ${text}`,
					},
				],
			});

			return translatedText;
		} catch (error) {
			console.error("Translation error:", error);
			if (retries > 1) {
				console.warn("Retrying translation...");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				retries--;
				continue;
			}
			throw error;
		}
	}
};

async function translateSingleFile(content: string, language: string, controller: ReadableStreamDefaultController, metadata: {fileName: string, fileIndex: number}) {
	try {
		const segments = content.split(/\r\n\r\n|\n\n/).map(parseSegment);
		const groups = groupSegmentsByTokenLength(segments, MAX_TOKENS_IN_SEGMENT);

		let currentIndex = 0;
		let resultContent = "";
		const encoder = new TextEncoder();

		// Send file start marker
		controller.enqueue(encoder.encode(JSON.stringify({
			type: "file_start",
			fileName: metadata.fileName,
			fileIndex: metadata.fileIndex
		}) + "\n"));

		for (const group of groups) {
			const text = group.map((segment) => segment.text).join("|");
			const translatedText = await retrieveTranslation(text, language);
			if (!translatedText) continue;

			const translatedSegments = translatedText.split("|");
			for (const segment of translatedSegments) {
				if (segment.trim()) {
					const originalSegment = segments[currentIndex];
					const srt = `${++currentIndex}\n${originalSegment?.timestamp || ""}\n${segment.trim()}\n\n`;
					resultContent += srt;

					// Send progress chunk
					controller.enqueue(encoder.encode(JSON.stringify({
						type: "chunk",
						fileIndex: metadata.fileIndex,
						content: srt
					}) + "\n"));
				}
			}
		}

		// Send file end marker with complete content
		controller.enqueue(encoder.encode(JSON.stringify({
			type: "file_complete",
			fileName: metadata.fileName,
			fileIndex: metadata.fileIndex,
			content: resultContent
		}) + "\n"));

		return resultContent;
	} catch (error) {
		console.error("Error translating file:", error);
		const encoder = new TextEncoder();
		// Send error notification
		controller.enqueue(encoder.encode(JSON.stringify({
			type: "file_error",
			fileName: metadata.fileName,
			fileIndex: metadata.fileIndex,
			error: "Failed to translate file"
		}) + "\n"));
		return null;
	}
}

export async function POST(request: Request) {
	try {
		const { files, language } = await request.json();
		const encoder = new TextEncoder();

		// Check if files is an array, otherwise convert to array for backward compatibility
		const filesArray = Array.isArray(files) ? files : [{ content: files.content, name: "translation.srt" }];

		const stream = new ReadableStream({
			async start(controller) {
				try {
					// Process all files in parallel
					await Promise.all(filesArray.map((file, index) =>
						translateSingleFile(file.content, language, controller, {
							fileName: file.name,
							fileIndex: index
						})
					));

					// Send completion signal
					controller.enqueue(encoder.encode(JSON.stringify({
						type: "all_complete",
						count: filesArray.length
					}) + "\n"));

					controller.close();
				} catch (error) {
					console.error("Translation process failed:", error);
					controller.enqueue(encoder.encode(JSON.stringify({
						type: "error",
						message: "Translation process failed"
					}) + "\n"));
					controller.close();
				}
			}
		});

		return new Response(stream);
	} catch (error) {
		console.error("Error during translation:", error);
		return new Response(JSON.stringify({ error: "Error during translation" }), {
			status: 500,
		});
	}
}
