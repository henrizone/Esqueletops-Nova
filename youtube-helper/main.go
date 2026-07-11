package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ruizlenato/youtubedl"
)

type selectedFormat struct {
	Itag         int    `json:"itag"`
	Size         int64  `json:"size"`
	Width        int    `json:"width,omitempty"`
	Height       int    `json:"height,omitempty"`
	QualityLabel string `json:"quality_label,omitempty"`
}

type infoOutput struct {
	ID              string          `json:"id"`
	Title           string          `json:"title"`
	Author          string          `json:"author"`
	DurationSeconds int64           `json:"duration_seconds"`
	Thumbnail       string          `json:"thumbnail,omitempty"`
	Video           *selectedFormat `json:"video,omitempty"`
	Audio           *selectedFormat `json:"audio,omitempty"`
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(1)
}

func clientWithCookies(cookiePath string) (*youtubedl.Client, error) {
	client, err := youtubedl.New()
	if err != nil {
		return nil, err
	}
	if cookiePath != "" {
		if _, err := os.Stat(cookiePath); err == nil {
			if err := client.LoadCookies(cookiePath); err != nil {
				return nil, fmt.Errorf("could not load YouTube cookies: %w", err)
			}
		}
	}
	return client, nil
}

func pickAudio(video *youtubedl.Video) (*youtubedl.Format, error) {
	if formats := video.Formats.Itag(140); len(formats) > 0 {
		preferred := formats.WithAudioChannels()
		if len(preferred) > 0 {
			return &preferred[0], nil
		}
		return &formats[0], nil
	}
	formats := video.Formats.WithAudioChannels().Type("audio/mp4")
	if len(formats) == 0 {
		formats = video.Formats.WithAudioChannels()
	}
	if len(formats) == 0 {
		return nil, errors.New("no YouTube audio format found")
	}
	sort.SliceStable(formats, func(i, j int) bool {
		return formats[i].Bitrate > formats[j].Bitrate
	})
	return &formats[0], nil
}

func wantedQuality(label string) bool {
	for _, quality := range []string{"1080p", "720p", "480p", "360p", "240p", "144p"} {
		if strings.Contains(label, quality) {
			return true
		}
	}
	return false
}

func pickVideo(video *youtubedl.Video, audio *youtubedl.Format, maxBytes int64) (*youtubedl.Format, error) {
	formats := video.Formats.Type("video/mp4")
	candidates := make([]youtubedl.Format, 0, len(formats))
	for _, format := range formats {
		if format.Height > 1080 || !wantedQuality(format.QualityLabel) {
			continue
		}
		combined := format.ContentLength
		if audio != nil {
			combined += audio.ContentLength
		}
		if maxBytes > 0 && combined > maxBytes {
			continue
		}
		candidates = append(candidates, format)
	}
	if len(candidates) == 0 {
		for _, format := range formats {
			if format.Height <= 1080 {
				candidates = append(candidates, format)
			}
		}
	}
	if len(candidates) == 0 {
		return nil, errors.New("no compatible YouTube video format found")
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Height != candidates[j].Height {
			return candidates[i].Height > candidates[j].Height
		}
		return candidates[i].Bitrate > candidates[j].Bitrate
	})
	return &candidates[0], nil
}

func thumbnail(video *youtubedl.Video) string {
	if len(video.Thumbnails) == 0 {
		return ""
	}
	return video.Thumbnails[len(video.Thumbnails)-1].URL
}

func buildInfo(video *youtubedl.Video, maxBytes int64) (*infoOutput, *youtubedl.Format, *youtubedl.Format, error) {
	audio, audioErr := pickAudio(video)
	videoFormat, videoErr := pickVideo(video, audio, maxBytes)
	if audioErr != nil && videoErr != nil {
		return nil, nil, nil, fmt.Errorf("no usable YouTube formats: %v; %v", videoErr, audioErr)
	}
	output := &infoOutput{
		ID:              video.ID,
		Title:           video.Title,
		Author:          video.Author,
		DurationSeconds: int64(video.Duration.Seconds()),
		Thumbnail:       thumbnail(video),
	}
	if videoFormat != nil {
		output.Video = &selectedFormat{
			Itag:         videoFormat.ItagNo,
			Size:         videoFormat.ContentLength,
			Width:        videoFormat.Width,
			Height:       videoFormat.Height,
			QualityLabel: videoFormat.QualityLabel,
		}
	}
	if audio != nil {
		output.Audio = &selectedFormat{Itag: audio.ItagNo, Size: audio.ContentLength}
	}
	return output, videoFormat, audio, nil
}

func streamToFile(client *youtubedl.Client, video *youtubedl.Video, format *youtubedl.Format, path string) error {
	stream, _, err := client.GetStream(video, format)
	if err != nil {
		return err
	}
	defer stream.Close()
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(file, stream)
	return err
}

func merge(videoPath, audioPath, output string) error {
	command := exec.Command("ffmpeg", "-y", "-i", videoPath, "-i", audioPath,
		"-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", output)
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	return command.Run()
}

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("usage: esqueletops-youtube <info|download> [options]"))
	}

	switch os.Args[1] {
	case "info":
		fs := flag.NewFlagSet("info", flag.ExitOnError)
		url := fs.String("url", "", "YouTube URL or video ID")
		cookies := fs.String("cookies", "", "Netscape cookie file")
		maxBytes := fs.Int64("max-bytes", 0, "maximum combined video size")
		_ = fs.Parse(os.Args[2:])
		if *url == "" {
			fail(errors.New("missing --url"))
		}
		client, err := clientWithCookies(*cookies)
		if err != nil {
			fail(err)
		}
		video, err := client.GetVideo(*url)
		if err != nil {
			fail(err)
		}
		info, _, _, err := buildInfo(video, *maxBytes)
		if err != nil {
			fail(err)
		}
		if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
			fail(err)
		}

	case "download":
		fs := flag.NewFlagSet("download", flag.ExitOnError)
		url := fs.String("url", "", "YouTube URL or video ID")
		mode := fs.String("mode", "video", "video or audio")
		output := fs.String("output", "", "output file")
		cookies := fs.String("cookies", "", "Netscape cookie file")
		maxBytes := fs.Int64("max-bytes", 0, "maximum combined video size")
		_ = fs.Parse(os.Args[2:])
		if *url == "" || *output == "" {
			fail(errors.New("missing --url or --output"))
		}
		if *mode != "video" && *mode != "audio" {
			fail(errors.New("--mode must be video or audio"))
		}
		client, err := clientWithCookies(*cookies)
		if err != nil {
			fail(err)
		}
		video, err := client.GetVideo(*url)
		if err != nil {
			fail(err)
		}
		info, videoFormat, audioFormat, err := buildInfo(video, *maxBytes)
		if err != nil {
			fail(err)
		}
		if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
			fail(err)
		}

		if *mode == "audio" {
			if audioFormat == nil {
				fail(errors.New("no YouTube audio format found"))
			}
			if err := streamToFile(client, video, audioFormat, *output); err != nil {
				fail(err)
			}
		} else {
			if videoFormat == nil || audioFormat == nil {
				fail(errors.New("no YouTube video/audio format found"))
			}
			directory, err := os.MkdirTemp("", "esqueletops-youtube-helper-")
			if err != nil {
				fail(err)
			}
			defer os.RemoveAll(directory)
			videoPath := filepath.Join(directory, "video.mp4")
			audioPath := filepath.Join(directory, "audio.m4a")
			if err := streamToFile(client, video, videoFormat, videoPath); err != nil {
				fail(err)
			}
			if err := streamToFile(client, video, audioFormat, audioPath); err != nil {
				fail(err)
			}
			if err := merge(videoPath, audioPath, *output); err != nil {
				fail(err)
			}
		}
		if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
			fail(err)
		}

	default:
		fail(fmt.Errorf("unknown command: %s", os.Args[1]))
	}
}
