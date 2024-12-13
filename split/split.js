import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegStatic);

async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

async function splitFile(filePath) {
  const duration = await getAudioDuration(filePath);
  const halfDuration = duration / 2;
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  const firstHalf = new Promise((resolve, reject) => {
    ffmpeg(filePath).setDuration(halfDuration).save(`${baseName}_part1${ext}`).on('end', resolve).on('error', reject);
  });

  const secondHalf = new Promise((resolve, reject) => {
    ffmpeg(filePath).setStartTime(halfDuration).save(`${baseName}_part2${ext}`).on('end', resolve).on('error', reject);
  });

  await Promise.all([firstHalf, secondHalf]);
  await fs.promises.unlink(filePath);
}

async function main() {
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];
  const files = await fs.promises.readdir('.');

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExtensions.includes(ext) && !file.includes('_part')) {
      try {
        await splitFile(file);
        console.log(`Successfully split ${file}`);
      } catch (error) {
        console.error(`Error processing ${file}:`, error.message);
      }
    }
  }
}

main().catch(console.error);
