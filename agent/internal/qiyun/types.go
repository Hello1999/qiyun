package qiyun

type Host struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Address  string    `json:"address"`
	OS       string    `json:"os"`
	Arch     string    `json:"arch"`
	Status   string    `json:"status"`
	CPU      *float64  `json:"cpu"`
	Memory   *float64  `json:"memory"`
	Disk     *float64  `json:"disk"`
	Uptime   float64   `json:"uptime"`
	LastSeen string    `json:"lastSeen"`
	Labels   []string  `json:"labels"`
	History  []float64 `json:"history"`
}
type Service struct {
	ID             string   `json:"id"`
	HostID         string   `json:"hostId"`
	Name           string   `json:"name"`
	Kind           string   `json:"kind"`
	Category       string   `json:"category"`
	Status         string   `json:"status"`
	State          string   `json:"state"`
	Image          string   `json:"image,omitempty"`
	Port           string   `json:"port,omitempty"`
	CPU            *float64 `json:"cpu"`
	Memory         *float64 `json:"memory"`
	Description    string   `json:"description"`
	UpdatedAt      string   `json:"updatedAt"`
	Revision       string   `json:"revision"`
	RestartAllowed bool     `json:"restartAllowed"`
}
type LogLine struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Message   string `json:"message"`
}
type Snapshot struct {
	Host     Host                 `json:"host"`
	Services []Service            `json:"services"`
	Logs     map[string][]LogLine `json:"logs"`
}
type ServiceSnapshot struct {
	Services []Service            `json:"services"`
	Logs     map[string][]LogLine `json:"logs"`
}
type Job struct {
	ID               string `json:"id"`
	TaskID           string `json:"taskId"`
	HostID           string `json:"hostId"`
	ServiceID        string `json:"serviceId"`
	Action           string `json:"action"`
	ExpectedRevision string `json:"expectedRevision"`
	ExpiresAt        string `json:"expiresAt"`
}
type SignedJob struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type JobResult struct {
	JobID    string `json:"jobId"`
	Status   string `json:"status"`
	Detail   string `json:"detail"`
	Revision string `json:"revision,omitempty"`
}
