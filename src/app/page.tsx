import PadGrid from '@/components/PadGrid';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-gray-100 dark:bg-gray-800">
      <h1 className="text-4xl font-bold mb-8 text-gray-900 dark:text-gray-100">
        ImpAmp 2 Soundboard
      </h1>
      <div className="w-full max-w-6xl">
        {/* TODO: Add Profile Selector and Page Controls here later */}
        <PadGrid rows={4} cols={8} />
      </div>
      {/* TODO: Add Footer or other UI elements later */}
    </main>
  );
}
