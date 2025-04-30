"use client";

import React, { useState, useEffect, useRef } from "react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { addAudioFile, upsertPadConfiguration } from "@/lib/db";
import { GRID_COLS, GRID_ROWS, TOTAL_PADS } from "@/lib/constants";

// Define special pad indices to avoid assignment
const SPECIAL_PAD_INDICES = [
  1 * GRID_COLS + (GRID_COLS - 1), // Stop All (Row 2, last col)
  2 * GRID_COLS + (GRID_COLS - 1), // Fade Out All (Row 3, last col)
];

interface AudioFilePreview {
  id: string; // Temporary ID for drag/drop
  file: File;
  name: string; // Display name (extracted from file)
  assignedPad: number | null;
}

interface PadAssignment {
  padIndex: number;
  fileName: string | null; // null means empty/available
  fileId: string | null; // References AudioFilePreview.id
  isConfigured: boolean; // Whether pad already has sounds assigned
}

interface BulkImportModalContentProps {
  profileId: number;
  pageIndex: number;
  existingPadConfigs: Map<number, { name?: string; soundCount: number }>;
  onAssignmentComplete: () => void;
}

interface DragEndResult {
  source: { droppableId: string; index: number };
  destination?: { droppableId: string; index: number } | null;
}

const BulkImportModalContent: React.FC<BulkImportModalContentProps> = ({
  profileId,
  pageIndex,
  existingPadConfigs,
  onAssignmentComplete,
}) => {
  // State for files to be imported
  const [fileList, setFileList] = useState<AudioFilePreview[]>([]);
  const [padAssignments, setPadAssignments] = useState<PadAssignment[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [isDragging, setIsDragging] = useState(false); // State needed for callbacks
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize pad assignments based on existing configurations
  useEffect(() => {
    const initialAssignments: PadAssignment[] = [];
    for (let i = 0; i < TOTAL_PADS; i++) {
      const config = existingPadConfigs.get(i);
      initialAssignments.push({
        padIndex: i,
        fileName: config?.name || null,
        fileId: null,
        isConfigured: (config?.soundCount || 0) > 0,
      });
    }
    setPadAssignments(initialAssignments);
  }, [existingPadConfigs]);

  // Handle file selection from input
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;

    const files = Array.from(e.target.files);
    const audioFiles = files.filter((file) => file.type.startsWith("audio/"));

    if (audioFiles.length === 0) {
      setErrorMessage("No audio files found in selection.");
      return;
    }

    const newFiles: AudioFilePreview[] = audioFiles.map((file) => ({
      id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      file,
      name: file.name.replace(/\.[^/.]+$/, ""), // Remove extension
      assignedPad: null,
    }));

    setFileList((prev) => [...prev, ...newFiles]);
    setErrorMessage(null);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Handle file removal from list
  const handleRemoveFile = (fileId: string) => {
    setFileList((prev) => prev.filter((file) => file.id !== fileId));

    // Also update any pad assignments using this file
    setPadAssignments((prev) =>
      prev.map((pad) =>
        pad.fileId === fileId ? { ...pad, fileId: null, fileName: null } : pad,
      ),
    );
  };

  // Assign files to pads automatically
  const handleAutoAssign = () => {
    // Get available pad indices (excluding special pads and already configured pads)
    const availablePads = padAssignments
      .filter(
        (pad) =>
          !pad.isConfigured && !SPECIAL_PAD_INDICES.includes(pad.padIndex),
      )
      .map((pad) => pad.padIndex);

    if (availablePads.length === 0) {
      setErrorMessage("No available pads for assignment.");
      return;
    }

    if (fileList.length === 0) {
      setErrorMessage("No files to assign.");
      return;
    }

    // Create new assignments
    const newAssignments = [...padAssignments];
    const unassignedFiles = [...fileList];

    // Assign files to pads
    let assignedCount = 0;
    for (
      let i = 0;
      i < availablePads.length && i < unassignedFiles.length;
      i++
    ) {
      const padIndex = availablePads[i];
      const file = unassignedFiles[i];

      const padAssignmentIndex = newAssignments.findIndex(
        (p) => p.padIndex === padIndex,
      );
      if (padAssignmentIndex !== -1) {
        newAssignments[padAssignmentIndex] = {
          ...newAssignments[padAssignmentIndex],
          fileId: file.id,
          fileName: file.name,
        };
        assignedCount++;
      }
    }

    setPadAssignments(newAssignments);

    if (assignedCount === 0) {
      setErrorMessage("Could not assign any files to pads.");
    } else {
      setErrorMessage(null);
    }
  };

  // Clear all assignments
  const handleClearAssignments = () => {
    setPadAssignments((prev) =>
      prev.map((pad) => ({
        ...pad,
        fileId: null,
        fileName: pad.isConfigured ? pad.fileName : null, // Keep original name for configured pads
      })),
    );
  };

  // Handle drag end event (from file to pad)
  const handleDragEnd = (result: DragEndResult) => {
    setIsDragging(false);

    // If dropped outside a droppable area
    if (!result.destination) return;

    const { source, destination } = result;

    // If dropping a file onto a pad
    if (
      source.droppableId === "file-list" &&
      destination.droppableId.startsWith("pad-")
    ) {
      const fileIndex = source.index;
      const padIndex = parseInt(
        destination.droppableId.replace("pad-", ""),
        10,
      );

      // Check if this is a special pad
      if (SPECIAL_PAD_INDICES.includes(padIndex)) {
        setErrorMessage("Cannot assign to special control pads.");
        return;
      }

      // Check if pad is already configured
      const padAssignment = padAssignments.find((p) => p.padIndex === padIndex);
      if (padAssignment?.isConfigured) {
        setErrorMessage("Cannot assign to pads that already have sounds.");
        return;
      }

      // Update pad assignment
      const file = fileList[fileIndex];
      setPadAssignments((prev) =>
        prev.map((pad) =>
          pad.padIndex === padIndex
            ? { ...pad, fileId: file.id, fileName: file.name }
            : pad,
        ),
      );
    }
    // Handle drag between pads (swap assignments)
    else if (
      destination.droppableId.startsWith("pad-") &&
      source.droppableId.startsWith("pad-")
    ) {
      const sourcePadIndex = parseInt(
        source.droppableId.replace("pad-", ""),
        10,
      );
      const destPadIndex = parseInt(
        destination.droppableId.replace("pad-", ""),
        10,
      );

      // Check if either pad is already configured
      const sourcePad = padAssignments.find(
        (p) => p.padIndex === sourcePadIndex,
      );
      const destPad = padAssignments.find((p) => p.padIndex === destPadIndex);

      if (sourcePad?.isConfigured || destPad?.isConfigured) {
        setErrorMessage("Cannot swap with pads that already have sounds.");
        return;
      }

      // Swap assignments
      setPadAssignments((prev) => {
        const newAssignments = [...prev];
        const sourceAssignment = newAssignments.find(
          (p) => p.padIndex === sourcePadIndex,
        );
        const destAssignment = newAssignments.find(
          (p) => p.padIndex === destPadIndex,
        );

        if (sourceAssignment && destAssignment) {
          const tempFileId = sourceAssignment.fileId;
          const tempFileName = sourceAssignment.fileName;

          sourceAssignment.fileId = destAssignment.fileId;
          sourceAssignment.fileName = destAssignment.fileName;

          destAssignment.fileId = tempFileId;
          destAssignment.fileName = tempFileName;
        }

        return newAssignments;
      });
    }
  };

  // Save all assignments and upload files
  const handleSaveAssignments = async () => {
    // Check if any files are assigned
    const hasAssignments = padAssignments.some((pad) => pad.fileId !== null);
    if (!hasAssignments) {
      setErrorMessage("No files have been assigned to pads.");
      return;
    }

    try {
      setIsImporting(true);
      setImportProgress(0);

      // Create a map of fileId to actual File object
      const fileMap = new Map<string, File>();
      fileList.forEach((filePreview) => {
        fileMap.set(filePreview.id, filePreview.file);
      });

      // Filter assignments that have files
      const assignmentsToProcess = padAssignments.filter(
        (assignment) => assignment.fileId !== null && !assignment.isConfigured,
      );

      if (assignmentsToProcess.length === 0) {
        setErrorMessage("No new assignments to save.");
        setIsImporting(false);
        return;
      }

      // Process each assignment
      for (let i = 0; i < assignmentsToProcess.length; i++) {
        const assignment = assignmentsToProcess[i];
        if (!assignment.fileId) continue;

        const file = fileMap.get(assignment.fileId);
        if (!file) continue;

        // Upload the file to IndexedDB
        const audioFileId = await addAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
        });

        // Create pad configuration
        await upsertPadConfiguration({
          profileId,
          pageIndex,
          padIndex: assignment.padIndex,
          audioFileIds: [audioFileId],
          playbackType: "sequential",
          name: assignment.fileName || file.name.replace(/\.[^/.]+$/, ""),
        });

        // Update progress
        setImportProgress(((i + 1) / assignmentsToProcess.length) * 100);
      }

      // Complete import
      setIsImporting(false);
      onAssignmentComplete();
    } catch (error) {
      console.error("Error during bulk import:", error);
      setErrorMessage(
        `Import failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setIsImporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full max-h-[80vh]">
      {/* Error message */}
      {errorMessage && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <span className="block sm:inline">{errorMessage}</span>
          <button
            className="float-right font-bold"
            onClick={() => setErrorMessage(null)}
          >
            &times;
          </button>
        </div>
      )}

      {/* Import progress */}
      {isImporting && (
        <div className="mb-4">
          <div className="text-sm font-medium mb-1">Importing files...</div>
          <div className="w-full bg-gray-200 rounded h-2.5">
            <div
              className="bg-blue-600 h-2.5 rounded"
              style={{ width: `${importProgress}%` }}
            ></div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-grow">
        {/* File List Panel */}
        <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700 flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-lg font-semibold">Files to Import</h3>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="audio/*"
                onChange={handleFileSelect}
                className="hidden"
                id="bulk-import-file-input"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-sm mr-2"
                disabled={isImporting}
              >
                Add Files
              </button>
            </div>
          </div>

          {/* File list with drag and drop */}
          <DragDropContext
            onDragStart={() => setIsDragging(true)}
            onDragEnd={handleDragEnd}
          >
            <Droppable droppableId="file-list">
              {(provided) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className="flex-grow overflow-y-auto"
                >
                  {fileList.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No files added. Click &quot;Add Files&quot; to select
                      audio files.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {fileList.map((file, index) => (
                        <Draggable
                          key={file.id}
                          draggableId={file.id}
                          index={index}
                        >
                          {(provided) => (
                            <li
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              className="bg-white dark:bg-gray-800 p-2 rounded flex justify-between items-center border border-gray-200 dark:border-gray-700"
                            >
                              <div className="truncate flex-grow pr-2">
                                {file.name}
                              </div>
                              <button
                                onClick={() => handleRemoveFile(file.id)}
                                className="text-red-500 hover:text-red-700"
                                disabled={isImporting}
                              >
                                &times;
                              </button>
                            </li>
                          )}
                        </Draggable>
                      ))}
                    </ul>
                  )}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>

          {/* Auto-assign buttons */}
          <div className="mt-4 flex justify-between">
            <button
              onClick={handleAutoAssign}
              className="bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded text-sm"
              disabled={fileList.length === 0 || isImporting}
            >
              Auto-Assign
            </button>
            <button
              onClick={handleClearAssignments}
              className="bg-gray-500 hover:bg-gray-600 text-white px-3 py-1 rounded text-sm"
              disabled={isImporting}
            >
              Clear All
            </button>
          </div>
        </div>

        {/* Pad Grid Panel */}
        <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700 flex flex-col">
          <h3 className="text-lg font-semibold mb-2">Pad Assignments</h3>

          {/* Grid layout */}
          <div
            className="grid gap-2 flex-grow overflow-y-auto"
            style={{
              gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 50px))`,
            }}
          >
            <DragDropContext
              onDragStart={() => setIsDragging(true)}
              onDragEnd={handleDragEnd}
            >
              {padAssignments.map((pad) => (
                <Droppable
                  key={`pad-${pad.padIndex}`}
                  droppableId={`pad-${pad.padIndex}`}
                  isDropDisabled={
                    pad.isConfigured ||
                    SPECIAL_PAD_INDICES.includes(pad.padIndex)
                  }
                >
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`
                        border rounded p-1 flex flex-col items-center justify-center overflow-hidden
                        ${
                          pad.isConfigured
                            ? "bg-gray-300 dark:bg-gray-700 cursor-not-allowed"
                            : "bg-white dark:bg-gray-800"
                        }
                        ${
                          SPECIAL_PAD_INDICES.includes(pad.padIndex)
                            ? "bg-gray-400 dark:bg-gray-600 cursor-not-allowed"
                            : ""
                        }
                        ${
                          snapshot.isDraggingOver && !pad.isConfigured
                            ? "border-blue-500 border-2"
                            : "border-gray-200 dark:border-gray-700"
                        }
                        ${pad.fileId ? "border-green-500 border-2" : ""}
                      `}
                    >
                      <div className="text-xs mb-1 text-center truncate w-full">
                        {pad.isConfigured
                          ? `⚠️ ${pad.fileName || `Pad ${pad.padIndex}`}`
                          : SPECIAL_PAD_INDICES.includes(pad.padIndex)
                            ? "Special Pad"
                            : pad.fileName || `Pad ${pad.padIndex}`}
                      </div>

                      {/* Show draggable element if there's a file assigned and pad is not configured */}
                      {pad.fileId && !pad.isConfigured && (
                        <Draggable
                          draggableId={`pad-item-${pad.padIndex}`}
                          index={0}
                        >
                          {(provided) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              className="bg-green-100 dark:bg-green-800 p-1 rounded text-xs w-full text-center truncate"
                            >
                              {pad.fileName}
                            </div>
                          )}
                        </Draggable>
                      )}

                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              ))}
            </DragDropContext>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-4 flex justify-end">
        <button
          onClick={handleSaveAssignments}
          className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
          disabled={isImporting}
        >
          {isImporting ? "Importing..." : "Save Assignments"}
        </button>
      </div>
    </div>
  );
};

export default BulkImportModalContent;
