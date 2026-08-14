Main goal for the project is to make a hr automation tool that helps hr to manage hiring process

I have a rough idea of using n8n, google sheet and a common dashboard that connect them and shows functions that we have perform with the automation running on the n8n which we can toggle to view it 

While creating this project please keep readme upto date with all the steps on how to run this project on their system and all

While creating this project I want to have best exception handling as when anything breaks I know exactly what is broken

First we will create V1 and then V2

Following is the process that I want to process:

For V1:
In n8n:
1.Excel sheet [updating using form or manualy which will contain resume link,resume pdf,category ,job role etc]

2.From excel we will gather information and then we will generate a respose using groq api key for them as per their role and also considering tempelate which will be uploaded by hr or generate (choice given and will be html embeded) and then in the dashboard hr have buttons to perform tasks like send email to all hire etc and all the advance function that we will give provide to hr such as replies given by applies and then further response and everything that easy their work


For V2:
In n8n:
1.Excel sheet [updating using form or manualy which will contain resume link,resume pdf,category ,job role etc]

2.From gathered data I want resumes to be converted into markdown files and everything

3.After markdown files are generated I want it to have to be analyses by groq apis keys model and then compare it with job description and display it's match percentage into another excel sheet/dashboard

4.After analysing/comparing I want to give HR all the tools to send them mail and everything so that they can have all the functions regarding functions used by them that can help them to hire


But there is a catch in this for ai I want to also keep gemini apis as backup and also while building this project I want that rate limitings of models in free groq apis gets considered so that we can manage accordingly and also if we are keeping rate limiting into consideration I want have a rough estimate on what time it will take to analyse 

Now I want this project to be hosted free so build it accordingly

For dashboard and things other than n8n please use the md file that we can
